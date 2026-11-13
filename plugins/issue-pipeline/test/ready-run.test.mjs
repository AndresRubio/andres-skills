import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReady } from '../skills/ship/scripts/lib/ready-run.mjs';
import { formatVerdictBody } from '../skills/ship/scripts/lib/verdict.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';
import { normalizeComments, PR_FIELDS } from '../skills/ship/scripts/lib/github.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { makeRepoWithOrigin } from './helpers/git.mjs';

const REPO = 'o/r';
const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-10-07T10:00:00Z');
// Every runReady call below names its run: the default reads GITHUB_RUN_ID, and inside GitHub
// Actions that would put the CI run's URL in the markers these tests compare.
const config = validateConfig({ tracker: { type: 'github' }, ciChecks: ['test'], mergeDeploys: false });
const run = (name, conclusion) => ({ __typename: 'CheckRun', name, conclusion, status: 'COMPLETED' });
const basePr = (over = {}) => ({
  number: 7, url: `https://github.com/${REPO}/pull/7`, title: 't', body: 'Fixes #5', headRefName: 'pipeline/5-x', headRefOid: HEAD, baseRefName: 'main',
  isDraft: false, isCrossRepository: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'SUCCESS')], ...over,
});
const verdictComment = (verdict, findings = []) => normalizeComments([{
  id: 1, user: { login: 'github-actions[bot]' }, author_association: 'NONE', created_at: '2026-10-07T09:00:00Z',
  body: formatVerdictBody({ verdict, head: HEAD, findings, diffRisk: [], marker: '**[issue-pipeline]** verdict · 2026-10-07T09:00:00Z · local' }),
}]);
const issue = (labels = ['pipeline', 'pipeline-working'], comments = []) => ({ number: 5, labels, comments });

function fakeDeps({ prs, comments = [], issue: iss = issue(), files = ['src/list.ts'], behindBy = 0 }) {
  const calls = [];
  const compares = [];
  return {
    calls,
    compares,
    deps: {
      listPrs: () => prs.map((p) => ({ number: p.number, headRefName: p.headRefName, isCrossRepository: p.isCrossRepository, isDraft: p.isDraft })),
      fetchPr: (repo, n) => prs.find((p) => p.number === n),
      fetchPrComments: () => comments,
      fetchIssue: () => iss,
      changedFiles: () => files,
      compare: (repo, base, head) => { compares.push([repo, base, head]); return { behind_by: behindBy }; },
      addLabel: (kind, n, label) => calls.push(['addLabel', kind, n, label]),
      removeLabel: (kind, n, label) => calls.push(['removeLabel', kind, n, label]),
      updateBranch: (n) => calls.push(['updateBranch', n]),
      comment: (kind, n, body) => calls.push(['comment', kind, n, body.split('\n')[0]]),
    },
  };
}

test('a green, accepted, current PR gets the ready label and reports on PR and issue, then the loop stops', async () => {
  const second = basePr({ number: 8, headRefName: 'pipeline/6-y', body: 'Fixes #6' });
  const { deps, calls } = fakeDeps({ prs: [basePr(), second], comments: verdictComment('accepted') });
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.deepEqual(r.actions.map((a) => [a.pr, a.action]), [[7, 'ready']]);
  assert.deepEqual(calls, [
    ['comment', 'pr', 7, '**[issue-pipeline]** ready · 2026-10-07T10:00:00Z · local'],
    ['comment', 'issue', 5, '**[issue-pipeline]** ready · 2026-10-07T10:00:00Z · local'],
    ['addLabel', 'pr', 7, 'ready'],
  ]);
});

test('revision needed labels pipeline-fix once; a second pass does nothing', async () => {
  const pr = basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] });
  const first = fakeDeps({ prs: [pr], comments: verdictComment('revision-needed', [{ file: 'a', line: 1, severity: 'Important', kind: 'unambiguous', problem: 'p', impact: 'i', correction: 'c' }]) });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, first.deps);
  assert.deepEqual(first.calls, [['addLabel', 'pr', 7, 'pipeline-fix']]);
  const second = fakeDeps({ prs: [{ ...pr, labels: ['pipeline-fix'] }], comments: first.deps.fetchPrComments() });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, second.deps);
  assert.deepEqual(second.calls, []);
});

test('human decision needed posts the judgment findings on the issue once per head and labels needs-decision', async () => {
  const judgment = { file: 'src/list.ts', line: 40, severity: 'Critical', kind: 'judgment', problem: 'archive deletes', impact: 'data loss', correction: 'decide', options: ['hide', 'delete'], recommendation: 'hide' };
  const pr = basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] });
  const first = fakeDeps({ prs: [pr], comments: verdictComment('human-decision-needed', [judgment]) });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, first.deps);
  assert.deepEqual(first.calls.map((c) => c.slice(0, 3)), [['comment', 'issue', 5], ['addLabel', 'issue', 5, 'needs-decision'].slice(0, 3)]);
  assert.equal(first.calls[1][3], 'needs-decision');
  const posted = normalizeComments([{ id: 9, user: { login: 'github-actions[bot]' }, author_association: 'NONE', created_at: '2026-10-07T10:00:00Z', body: `**[issue-pipeline]** blocked · 2026-10-07T10:00:00Z · local\n\nReview verdict on PR #7: human decision needed at head \`${HEAD.slice(0, 7)}\`.` }]);
  const second = fakeDeps({ prs: [pr], comments: first.deps.fetchPrComments(), issue: issue(['pipeline', 'needs-decision'], posted) });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, second.deps);
  assert.deepEqual(second.calls, []);
});

test('a missing verdict with a failed review check is a human decision', async () => {
  const pr = basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] });
  const { deps, calls } = fakeDeps({ prs: [pr], comments: [] });
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.equal(r.actions[0].action, 'needs-decision');
  assert.equal(calls[0][0], 'comment');
  assert.equal(calls[1][3], 'needs-decision');
});

test('behind base removes ready and updates the branch; conflict removes ready and asks for a fix', async () => {
  const behind = fakeDeps({ prs: [basePr({ mergeStateStatus: 'BEHIND', labels: ['ready'] })], comments: verdictComment('accepted') });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, behind.deps);
  assert.deepEqual(behind.calls, [['removeLabel', 'pr', 7, 'ready'], ['updateBranch', 7]]);
  const conflict = fakeDeps({ prs: [basePr({ mergeable: 'CONFLICTING', labels: ['ready'] })], comments: verdictComment('accepted') });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, conflict.deps);
  assert.deepEqual(conflict.calls, [['removeLabel', 'pr', 7, 'ready'], ['addLabel', 'pr', 7, 'pipeline-fix']]);
});

test('red CI asks for a fix; pending waits; drafts, forks and other branches are skipped; disabled does nothing', async () => {
  const red = fakeDeps({ prs: [basePr({ statusCheckRollup: [run('test', 'FAILURE'), run('pipeline-review', 'SUCCESS')] })], comments: verdictComment('accepted') });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, red.deps);
  assert.deepEqual(red.calls, [['addLabel', 'pr', 7, 'pipeline-fix']]);
  const pending = fakeDeps({ prs: [basePr({ statusCheckRollup: [run('test', 'SUCCESS'), { __typename: 'CheckRun', name: 'pipeline-review', status: 'IN_PROGRESS', conclusion: null }] })], comments: [] });
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, pending.deps);
  assert.deepEqual([r.actions[0].action, pending.calls], ['wait', []]);
  const skipped = fakeDeps({ prs: [basePr({ isDraft: true }), basePr({ number: 8, isCrossRepository: true }), basePr({ number: 9, headRefName: 'feat/x' })] });
  const s = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, skipped.deps);
  assert.deepEqual([s.actions, skipped.calls], [[], []]);
  const off = await runReady({ repo: REPO, config: { ...config, enabled: false }, now: NOW, run: 'local' }, red.deps);
  assert.deepEqual(off, { actions: [], disabled: true });
});

test('dry run decides without acting', async () => {
  const { deps, calls } = fakeDeps({ prs: [basePr()], comments: verdictComment('accepted') });
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local', dryRun: true }, deps);
  assert.deepEqual([r.actions[0].action, r.actions[0].done, calls], ['ready', ['would comment on PR 7', 'would comment on issue 5', 'would add label ready'], []]);
});

const judgmentFinding = { file: 'src/list.ts', line: 40, severity: 'Critical', kind: 'judgment', problem: 'archive deletes', impact: 'data loss', correction: 'decide' };
const asComment = (id, body) => normalizeComments([{ id, user: { login: 'github-actions[bot]' }, author_association: 'NONE', created_at: '2026-10-07T10:00:00Z', body }]);

test('without a linked issue the blocked comment goes on the PR once per head', async () => {
  const pr = basePr({ body: 'no link', statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] });
  const verdicts = verdictComment('human-decision-needed', [judgmentFinding]);
  const first = fakeDeps({ prs: [pr], comments: verdicts });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, first.deps);
  assert.deepEqual(first.calls, [['comment', 'pr', 7, '**[issue-pipeline]** blocked · 2026-10-07T10:00:00Z · local']]);
  const posted = asComment(9, `**[issue-pipeline]** blocked · 2026-10-07T10:00:00Z · local\n\nReview verdict on PR #7: human decision needed at head \`${HEAD.slice(0, 7)}\`.`);
  const second = fakeDeps({ prs: [pr], comments: [...verdicts, ...posted] });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, second.deps);
  assert.deepEqual(second.calls, []);
});

test('a missed needs-decision label is repaired even when the blocked comment already exists', async () => {
  const pr = basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] });
  const posted = asComment(9, `**[issue-pipeline]** blocked · 2026-10-07T10:00:00Z · local\n\nReview verdict on PR #7: human decision needed at head \`${HEAD.slice(0, 7)}\`.`);
  const { deps, calls } = fakeDeps({ prs: [pr], comments: verdictComment('human-decision-needed', [judgmentFinding]), issue: issue(['pipeline'], posted) });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.deepEqual(calls, [['addLabel', 'issue', 5, 'needs-decision']]);
});

test('a ready report already on the PR is not posted twice, and the label is still added', async () => {
  const report = asComment(9, `**[issue-pipeline]** ready · 2026-10-07T09:30:00Z · local\n\n**Ready to merge** at head \`${HEAD.slice(0, 7)}\`.`);
  const { deps, calls } = fakeDeps({ prs: [basePr()], comments: [...verdictComment('accepted'), ...report] });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.deepEqual(calls, [
    ['comment', 'issue', 5, '**[issue-pipeline]** ready · 2026-10-07T10:00:00Z · local'],
    ['addLabel', 'pr', 7, 'ready'],
  ]);
});

test('an error on one PR is recorded and the queue continues', async () => {
  const bad = basePr({ body: 'Fixes #999', statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] });
  const good = basePr({ number: 8, headRefName: 'pipeline/6-y', body: 'Fixes #6' });
  const { deps, calls } = fakeDeps({ prs: [bad, good], comments: verdictComment('human-decision-needed', [judgmentFinding]) });
  deps.fetchIssue = (r, n) => { if (n === 999) throw new Error('issue 999 not found'); return issue(); };
  deps.fetchPrComments = (r, n) => (n === 8 ? verdictComment('accepted') : verdictComment('human-decision-needed', [judgmentFinding]));
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.deepEqual(r.actions.map((a) => [a.pr, a.action]), [[7, 'error'], [8, 'ready']]);
  assert.equal(r.actions[0].reason, 'issue 999 not found');
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [['comment', 'pr', 8], ['comment', 'issue', 6], ['addLabel', 'pr', 8]]);
});

test('the CLI prints the result and exits 1 when any PR errored', () => {
  const dir = fakeGh({
    [`pr list --repo ${REPO} --state open --limit 500 --json number,headRefName,isCrossRepository,isDraft`]: [{ number: 7, headRefName: 'pipeline/5-x', isCrossRepository: false, isDraft: false }],
    [`pr view 7 --repo ${REPO} --json ${PR_FIELDS}`]: { __ghError: 'boom' },
  });
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' } }) });
  const r = runCli(['ready', '--repo', REPO, '--repo-root', root, '--dry-run'], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.code, 1, r.stderr);
  const out = r.json();
  assert.deepEqual(out.actions.map((a) => [a.pr, a.action]), [[7, 'error']]);
});

test('the CLI loads pipeline.json from the default branch of --repo-root (the workflow\'s exact call)', () => {
  const dir = fakeGh({
    [`pr list --repo ${REPO} --state open --limit 500 --json number,headRefName,isCrossRepository,isDraft`]: [],
  });
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, ciChecks: ['test'] }) });
  const r = runCli(['ready', '--repo-root', root, '--repo', REPO], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json(), { actions: [] });
});

test('the CLI no longer takes --config-file and requires --repo-root', () => {
  assert.equal(runCli(['ready', '--repo', REPO]).code, 2);
  assert.equal(runCli(['ready', '--repo', REPO, '--config-file', 'x.json']).code, 2);
});

test('a stale ready label is removed when the head is no longer green', async () => {
  const red = fakeDeps({ prs: [basePr({ labels: ['ready'], statusCheckRollup: [run('test', 'FAILURE'), run('pipeline-review', 'SUCCESS')] })], comments: verdictComment('accepted') });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, red.deps);
  assert.deepEqual(red.calls, [['removeLabel', 'pr', 7, 'ready'], ['addLabel', 'pr', 7, 'pipeline-fix']]);
  const pending = fakeDeps({ prs: [basePr({ labels: ['ready'], statusCheckRollup: [run('test', 'SUCCESS'), { __typename: 'CheckRun', name: 'pipeline-review', status: 'IN_PROGRESS', conclusion: null }] })], comments: [] });
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, pending.deps);
  assert.deepEqual([r.actions[0].action, pending.calls], ['wait', [['removeLabel', 'pr', 7, 'ready']]]);
});

const lockAt = (iso) => normalizeComments([{ id: 50, user: { login: 'claude[bot]' }, author_association: 'NONE', created_at: iso, body: `**[issue-pipeline]** lock · ${iso} · local` }]);
const revision = verdictComment('revision-needed', [{ file: 'a', line: 1, severity: 'Important', kind: 'unambiguous', problem: 'p', impact: 'i', correction: 'c' }]);
const reviewRed = () => basePr({ labels: ['ready'], statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] });

test('a fix, update or needs-decision waits with no writes at all while the linked issue has a fresh pipeline-working lock', async () => {
  const working = issue(['pipeline', 'pipeline-working'], lockAt('2026-10-07T09:30:00Z'));
  for (const [pr, comments] of [
    [reviewRed(), revision],
    [basePr({ labels: ['ready'], mergeStateStatus: 'BEHIND' }), verdictComment('accepted')],
    [reviewRed(), verdictComment('human-decision-needed', [judgmentFinding])],
  ]) {
    const { deps, calls } = fakeDeps({ prs: [pr], comments, issue: working });
    const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
    assert.deepEqual(r.actions.map((a) => [a.action, a.reason]), [['wait', 'fix run in progress (pipeline-working on issue 5)']]);
    assert.deepEqual(calls, []);
  }
});

test('without pipeline-working, or with a lock older than lockTtlHours, the fix request goes ahead', async () => {
  for (const iss of [issue(['pipeline'], lockAt('2026-10-07T09:30:00Z')), issue(['pipeline', 'pipeline-working'], lockAt('2026-10-07T05:00:00Z'))]) {
    const { deps, calls } = fakeDeps({ prs: [reviewRed()], comments: revision, issue: iss });
    const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
    assert.equal(r.actions[0].action, 'fix');
    assert.deepEqual(calls, [['removeLabel', 'pr', 7, 'ready'], ['addLabel', 'pr', 7, 'pipeline-fix']]);
  }
});

test('a PR without a linked issue is not gated by any lock', async () => {
  const { deps, calls } = fakeDeps({ prs: [basePr({ body: 'no link', statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] })], comments: revision });
  deps.fetchIssue = () => { throw new Error('should not fetch'); };
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.equal(r.actions[0].action, 'fix');
  assert.deepEqual(calls, [['addLabel', 'pr', 7, 'pipeline-fix']]);
});

test('a PR that would be ready but is behind its base (compare API) gets a branch update instead (final review I8)', async () => {
  const plain = fakeDeps({ prs: [basePr()], comments: verdictComment('accepted'), behindBy: 2 });
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, plain.deps);
  assert.deepEqual(r.actions.map((a) => [a.action, a.reason]), [['update', 'behind base']]);
  assert.deepEqual(plain.compares, [[REPO, 'main', HEAD]]);
  assert.deepEqual(plain.calls, [['updateBranch', 7]]);
  const labelled = fakeDeps({ prs: [basePr({ labels: ['ready'] })], comments: verdictComment('accepted'), behindBy: 1 });
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, labelled.deps);
  assert.deepEqual(labelled.calls, [['removeLabel', 'pr', 7, 'ready'], ['updateBranch', 7]]);
  const locked = fakeDeps({ prs: [basePr({ labels: ['ready'] })], comments: verdictComment('accepted'), behindBy: 1, issue: issue(['pipeline', 'pipeline-working'], lockAt('2026-10-07T09:30:00Z')) });
  const w = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, locked.deps);
  assert.equal(w.actions[0].action, 'wait');
  assert.deepEqual(locked.calls, []);
});

test('a ready PR that is not behind stays ready; already-ready is checked too', async () => {
  const current = fakeDeps({ prs: [basePr({ labels: ['ready'] })], comments: verdictComment('accepted') });
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, current.deps);
  assert.equal(r.actions[0].action, 'already-ready');
  assert.deepEqual([current.compares, current.calls], [[[REPO, 'main', HEAD]], []]);
});

test('a sampled PR gets pipeline-score dispatched after the ready label; others do not; a failed dispatch changes nothing', async () => {
  const sampled = basePr({ body: 'Fixes #8', headRefName: 'pipeline/8-x' });
  const a = fakeDeps({ prs: [sampled], comments: verdictComment('accepted'), issue: { number: 8, labels: ['pipeline'], comments: [] } });
  a.deps.dispatchScore = (n) => a.calls.push(['dispatchScore', n]);
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, a.deps);
  assert.deepEqual(a.calls.slice(-2), [['addLabel', 'pr', 7, 'ready'], ['dispatchScore', 7]]);

  const b = fakeDeps({ prs: [basePr()], comments: verdictComment('accepted') });
  b.deps.dispatchScore = (n) => b.calls.push(['dispatchScore', n]);
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, b.deps);
  assert.ok(!b.calls.some((c) => c[0] === 'dispatchScore'));

  const c = fakeDeps({ prs: [sampled], comments: verdictComment('accepted'), issue: { number: 8, labels: ['pipeline'], comments: [] } });
  c.deps.dispatchScore = () => { throw new Error('HTTP 403'); };
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, c.deps);
  assert.equal(r.actions[0].action, 'ready');
  assert.ok(r.actions[0].done.includes('score dispatch failed: HTTP 403'));
  assert.ok(!r.actions[0].done.includes('dispatch pipeline-score'), 'a failed dispatch is not recorded as done');
});

test('a successful score dispatch is recorded as done; a dry run says "would"', async () => {
  const sampled = basePr({ body: 'Fixes #8', headRefName: 'pipeline/8-x' });
  const issue = { number: 8, labels: ['pipeline'], comments: [] };
  const ok = fakeDeps({ prs: [sampled], comments: verdictComment('accepted'), issue });
  ok.deps.dispatchScore = (n) => ok.calls.push(['dispatchScore', n]);
  const okRun = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, ok.deps);
  assert.ok(okRun.actions[0].done.includes('dispatch pipeline-score'));
  const dry = fakeDeps({ prs: [sampled], comments: verdictComment('accepted'), issue });
  dry.deps.dispatchScore = () => { throw new Error('must not run'); };
  const dryRun = await runReady({ repo: REPO, config, now: NOW, run: 'local', dryRun: true }, dry.deps);
  assert.ok(dryRun.actions[0].done.includes('would dispatch pipeline-score'));
});

test('the ready report carries the run summary from run.json at the head SHA', async () => {
  const bodies = [];
  const runJsonCalls = [];
  const { deps } = fakeDeps({ prs: [basePr()], comments: verdictComment('accepted') });
  deps.comment = (kind, n, body) => bodies.push([kind, body]);
  deps.runJson = (repo, sha, key) => { runJsonCalls.push([repo, sha, key]); return { version: 1, runs: [{ kind: 'ship', seconds: 1800, tokens: { input: 1000, output: 1000, cacheRead: 8000, cacheWrite: 0 }, usd: 2.5 }] }; };
  await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.deepEqual(runJsonCalls, [[REPO, HEAD, '5']]);
  assert.match(bodies[0][1], /\nRun: 1 run \(1 ship, 0 fix\), 30 min, 10k tokens \(80% cache reads\), \$2\.50\n/);
});

test('a missing or broken run.json leaves the report without a run line and the PR still ready', async () => {
  for (const runJson of [() => null, () => { throw new Error('boom'); }, () => ({ version: 1, runs: 'nope' }), () => ({ runs: [null] })]) {
    const bodies = [];
    const { deps, calls } = fakeDeps({ prs: [basePr()], comments: verdictComment('accepted') });
    deps.comment = (kind, n, body) => { bodies.push(body); calls.push(['comment', kind, n]); };
    deps.runJson = runJson;
    const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
    assert.equal(r.actions[0].action, 'ready');
    assert.doesNotMatch(bodies[0], /\nRun: /);
    assert.ok(calls.some((c) => c[0] === 'addLabel' && c[3] === 'ready'));
  }
});

test('a branch whose key is not a plain id is skipped before run.json is looked up', async () => {
  const runJsonCalls = [];
  const { deps, calls } = fakeDeps({ prs: [basePr({ headRefName: 'pipeline/../../secrets' }), basePr({ number: 8, headRefName: 'pipeline/5%2f..-x' })], comments: verdictComment('accepted') });
  deps.runJson = (...args) => { runJsonCalls.push(args); return null; };
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(runJsonCalls, []);
  assert.deepEqual(calls, []);
});

const reviewing = (over = {}) => basePr({ statusCheckRollup: [run('test', 'SUCCESS'), { __typename: 'CheckRun', name: 'pipeline-review', status: 'IN_PROGRESS', conclusion: null }], ...over });

test('a PR behind its base (compare API) while its review still runs gets the base now, so the review is paid for once', async () => {
  const behind = fakeDeps({ prs: [reviewing()], behindBy: 2 });
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, behind.deps);
  assert.deepEqual(r.actions.map((a) => [a.action, a.reason, a.done]), [['update', 'behind base', ['update branch']]]);
  assert.deepEqual([behind.compares, behind.calls], [[[REPO, 'main', HEAD]], [['updateBranch', 7]]]);
  const current = fakeDeps({ prs: [reviewing()] });
  const c = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, current.deps);
  assert.deepEqual([c.actions[0].action, c.actions[0].reason, current.calls], ['wait', 'not success yet: pipeline-review', []]);
  // The lock of a run that is still pushing holds the update back, as it does for a green PR.
  const locked = fakeDeps({ prs: [reviewing()], behindBy: 2, issue: issue(['pipeline', 'pipeline-working'], lockAt('2026-10-07T09:30:00Z')) });
  const l = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, locked.deps);
  assert.deepEqual([l.actions[0].reason, locked.calls], ['fix run in progress (pipeline-working on issue 5)', []]);
  // A PR that needs a fix is not compared: the fix run brings the base in, and an update here
  // would pay for a review of a head the fix is about to replace.
  const fixing = fakeDeps({ prs: [basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('pipeline-review', 'FAILURE')] })], comments: revision, behindBy: 2 });
  const f = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, fixing.deps);
  assert.deepEqual([f.actions[0].action, fixing.compares, fixing.calls], ['fix', [], [['addLabel', 'pr', 7, 'pipeline-fix']]]);
});

test('a waiting PR that GitHub cannot merge cleanly, or has not judged yet, is left to wait and is not compared', async () => {
  // update-branch answers 422 on a conflict, which would turn a wait into an error on every run.
  for (const mergeable of ['CONFLICTING', 'UNKNOWN']) {
    const { deps, calls, compares } = fakeDeps({ prs: [reviewing({ mergeable })], behindBy: 2 });
    const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
    assert.deepEqual([r.actions[0].action, compares, calls], ['wait', [], []], mergeable);
  }
});

test('a step that fails is not listed as done', async () => {
  const { deps } = fakeDeps({ prs: [basePr()], comments: verdictComment('accepted') });
  deps.addLabel = () => { throw new Error('Resource not accessible by personal access token'); };
  const r = await runReady({ repo: REPO, config, now: NOW, run: 'local' }, deps);
  assert.deepEqual(r.actions, [{ pr: 7, action: 'error', reason: 'Resource not accessible by personal access token', done: ['comment on PR 7', 'comment on issue 5'] }]);
});
