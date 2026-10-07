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
const config = validateConfig({ tracker: { type: 'github' }, ciChecks: ['test'], mergeDeploys: false });
const run = (name, conclusion) => ({ __typename: 'CheckRun', name, conclusion, status: 'COMPLETED' });
const basePr = (over = {}) => ({
  number: 7, url: `https://github.com/${REPO}/pull/7`, title: 't', body: 'Fixes #5', headRefName: 'claude/5-x', headRefOid: HEAD, baseRefName: 'main',
  isDraft: false, isCrossRepository: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'SUCCESS')], ...over,
});
const verdictComment = (verdict, findings = []) => normalizeComments([{
  id: 1, user: { login: 'github-actions[bot]' }, author_association: 'NONE', created_at: '2026-10-07T09:00:00Z',
  body: formatVerdictBody({ verdict, head: HEAD, findings, diffRisk: [], marker: '**[claude-pipeline]** verdict · 2026-10-07T09:00:00Z · local' }),
}]);
const issue = (labels = ['claude', 'claude-working'], comments = []) => ({ number: 5, labels, comments });

function fakeDeps({ prs, comments = [], issue: iss = issue(), files = ['src/list.ts'] }) {
  const calls = [];
  return {
    calls,
    deps: {
      listPrs: () => prs.map((p) => ({ number: p.number, headRefName: p.headRefName, isCrossRepository: p.isCrossRepository, isDraft: p.isDraft })),
      fetchPr: (repo, n) => prs.find((p) => p.number === n),
      fetchPrComments: () => comments,
      fetchIssue: () => iss,
      changedFiles: () => files,
      addLabel: (kind, n, label) => calls.push(['addLabel', kind, n, label]),
      removeLabel: (kind, n, label) => calls.push(['removeLabel', kind, n, label]),
      updateBranch: (n) => calls.push(['updateBranch', n]),
      comment: (kind, n, body) => calls.push(['comment', kind, n, body.split('\n')[0]]),
    },
  };
}

test('a green, accepted, current PR gets the ready label and reports on PR and issue, then the loop stops', async () => {
  const second = basePr({ number: 8, headRefName: 'claude/6-y', body: 'Fixes #6' });
  const { deps, calls } = fakeDeps({ prs: [basePr(), second], comments: verdictComment('accepted') });
  const r = await runReady({ repo: REPO, config, now: NOW }, deps);
  assert.deepEqual(r.actions.map((a) => [a.pr, a.action]), [[7, 'ready']]);
  assert.deepEqual(calls, [
    ['comment', 'pr', 7, '**[claude-pipeline]** ready · 2026-10-07T10:00:00Z · local'],
    ['comment', 'issue', 5, '**[claude-pipeline]** ready · 2026-10-07T10:00:00Z · local'],
    ['addLabel', 'pr', 7, 'ready'],
  ]);
});

test('revision needed labels claude-fix once; a second pass does nothing', async () => {
  const pr = basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });
  const first = fakeDeps({ prs: [pr], comments: verdictComment('revision-needed', [{ file: 'a', line: 1, severity: 'Important', kind: 'unambiguous', problem: 'p', impact: 'i', correction: 'c' }]) });
  await runReady({ repo: REPO, config, now: NOW }, first.deps);
  assert.deepEqual(first.calls, [['addLabel', 'pr', 7, 'claude-fix']]);
  const second = fakeDeps({ prs: [{ ...pr, labels: ['claude-fix'] }], comments: first.deps.fetchPrComments() });
  await runReady({ repo: REPO, config, now: NOW }, second.deps);
  assert.deepEqual(second.calls, []);
});

test('human decision needed posts the judgment findings on the issue once per head and labels needs-decision', async () => {
  const judgment = { file: 'src/list.ts', line: 40, severity: 'Critical', kind: 'judgment', problem: 'archive deletes', impact: 'data loss', correction: 'decide', options: ['hide', 'delete'], recommendation: 'hide' };
  const pr = basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });
  const first = fakeDeps({ prs: [pr], comments: verdictComment('human-decision-needed', [judgment]) });
  await runReady({ repo: REPO, config, now: NOW }, first.deps);
  assert.deepEqual(first.calls.map((c) => c.slice(0, 3)), [['comment', 'issue', 5], ['addLabel', 'issue', 5, 'needs-decision'].slice(0, 3)]);
  assert.equal(first.calls[1][3], 'needs-decision');
  const posted = normalizeComments([{ id: 9, user: { login: 'github-actions[bot]' }, author_association: 'NONE', created_at: '2026-10-07T10:00:00Z', body: `**[claude-pipeline]** blocked · 2026-10-07T10:00:00Z · local\n\nReview verdict on PR #7: human decision needed at head \`${HEAD.slice(0, 7)}\`.` }]);
  const second = fakeDeps({ prs: [pr], comments: first.deps.fetchPrComments(), issue: issue(['claude', 'needs-decision'], posted) });
  await runReady({ repo: REPO, config, now: NOW }, second.deps);
  assert.deepEqual(second.calls, []);
});

test('a missing verdict with a failed review check is a human decision', async () => {
  const pr = basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });
  const { deps, calls } = fakeDeps({ prs: [pr], comments: [] });
  const r = await runReady({ repo: REPO, config, now: NOW }, deps);
  assert.equal(r.actions[0].action, 'needs-decision');
  assert.equal(calls[0][0], 'comment');
  assert.equal(calls[1][3], 'needs-decision');
});

test('behind base removes ready and updates the branch; conflict removes ready and asks for a fix', async () => {
  const behind = fakeDeps({ prs: [basePr({ mergeStateStatus: 'BEHIND', labels: ['ready'] })], comments: verdictComment('accepted') });
  await runReady({ repo: REPO, config, now: NOW }, behind.deps);
  assert.deepEqual(behind.calls, [['removeLabel', 'pr', 7, 'ready'], ['updateBranch', 7]]);
  const conflict = fakeDeps({ prs: [basePr({ mergeable: 'CONFLICTING', labels: ['ready'] })], comments: verdictComment('accepted') });
  await runReady({ repo: REPO, config, now: NOW }, conflict.deps);
  assert.deepEqual(conflict.calls, [['removeLabel', 'pr', 7, 'ready'], ['addLabel', 'pr', 7, 'claude-fix']]);
});

test('red CI asks for a fix; pending waits; drafts, forks and other branches are skipped; disabled does nothing', async () => {
  const red = fakeDeps({ prs: [basePr({ statusCheckRollup: [run('test', 'FAILURE'), run('claude-review', 'SUCCESS')] })], comments: verdictComment('accepted') });
  await runReady({ repo: REPO, config, now: NOW }, red.deps);
  assert.deepEqual(red.calls, [['addLabel', 'pr', 7, 'claude-fix']]);
  const pending = fakeDeps({ prs: [basePr({ statusCheckRollup: [run('test', 'SUCCESS'), { __typename: 'CheckRun', name: 'claude-review', status: 'IN_PROGRESS', conclusion: null }] })], comments: [] });
  const r = await runReady({ repo: REPO, config, now: NOW }, pending.deps);
  assert.deepEqual([r.actions[0].action, pending.calls], ['wait', []]);
  const skipped = fakeDeps({ prs: [basePr({ isDraft: true }), basePr({ number: 8, isCrossRepository: true }), basePr({ number: 9, headRefName: 'feat/x' })] });
  const s = await runReady({ repo: REPO, config, now: NOW }, skipped.deps);
  assert.deepEqual([s.actions, skipped.calls], [[], []]);
  const off = await runReady({ repo: REPO, config: { ...config, enabled: false }, now: NOW }, red.deps);
  assert.deepEqual(off, { actions: [], disabled: true });
});

test('dry run decides without acting', async () => {
  const { deps, calls } = fakeDeps({ prs: [basePr()], comments: verdictComment('accepted') });
  const r = await runReady({ repo: REPO, config, now: NOW, dryRun: true }, deps);
  assert.deepEqual([r.actions[0].action, r.actions[0].done, calls], ['ready', ['would comment on PR 7', 'would comment on issue 5', 'would add label ready'], []]);
});

const judgmentFinding = { file: 'src/list.ts', line: 40, severity: 'Critical', kind: 'judgment', problem: 'archive deletes', impact: 'data loss', correction: 'decide' };
const asComment = (id, body) => normalizeComments([{ id, user: { login: 'github-actions[bot]' }, author_association: 'NONE', created_at: '2026-10-07T10:00:00Z', body }]);

test('without a linked issue the blocked comment goes on the PR once per head', async () => {
  const pr = basePr({ body: 'no link', statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });
  const verdicts = verdictComment('human-decision-needed', [judgmentFinding]);
  const first = fakeDeps({ prs: [pr], comments: verdicts });
  await runReady({ repo: REPO, config, now: NOW }, first.deps);
  assert.deepEqual(first.calls, [['comment', 'pr', 7, '**[claude-pipeline]** blocked · 2026-10-07T10:00:00Z · local']]);
  const posted = asComment(9, `**[claude-pipeline]** blocked · 2026-10-07T10:00:00Z · local\n\nReview verdict on PR #7: human decision needed at head \`${HEAD.slice(0, 7)}\`.`);
  const second = fakeDeps({ prs: [pr], comments: [...verdicts, ...posted] });
  await runReady({ repo: REPO, config, now: NOW }, second.deps);
  assert.deepEqual(second.calls, []);
});

test('a missed needs-decision label is repaired even when the blocked comment already exists', async () => {
  const pr = basePr({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });
  const posted = asComment(9, `**[claude-pipeline]** blocked · 2026-10-07T10:00:00Z · local\n\nReview verdict on PR #7: human decision needed at head \`${HEAD.slice(0, 7)}\`.`);
  const { deps, calls } = fakeDeps({ prs: [pr], comments: verdictComment('human-decision-needed', [judgmentFinding]), issue: issue(['claude'], posted) });
  await runReady({ repo: REPO, config, now: NOW }, deps);
  assert.deepEqual(calls, [['addLabel', 'issue', 5, 'needs-decision']]);
});

test('a ready report already on the PR is not posted twice, and the label is still added', async () => {
  const report = asComment(9, `**[claude-pipeline]** ready · 2026-10-07T09:30:00Z · local\n\n**Ready to merge** at head \`${HEAD.slice(0, 7)}\`.`);
  const { deps, calls } = fakeDeps({ prs: [basePr()], comments: [...verdictComment('accepted'), ...report] });
  await runReady({ repo: REPO, config, now: NOW }, deps);
  assert.deepEqual(calls, [
    ['comment', 'issue', 5, '**[claude-pipeline]** ready · 2026-10-07T10:00:00Z · local'],
    ['addLabel', 'pr', 7, 'ready'],
  ]);
});

test('an error on one PR is recorded and the queue continues', async () => {
  const bad = basePr({ body: 'Fixes #999', statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });
  const good = basePr({ number: 8, headRefName: 'claude/6-y', body: 'Fixes #6' });
  const { deps, calls } = fakeDeps({ prs: [bad, good], comments: verdictComment('human-decision-needed', [judgmentFinding]) });
  deps.fetchIssue = (r, n) => { if (n === 999) throw new Error('issue 999 not found'); return issue(); };
  deps.fetchPrComments = (r, n) => (n === 8 ? verdictComment('accepted') : verdictComment('human-decision-needed', [judgmentFinding]));
  const r = await runReady({ repo: REPO, config, now: NOW }, deps);
  assert.deepEqual(r.actions.map((a) => [a.pr, a.action]), [[7, 'error'], [8, 'ready']]);
  assert.equal(r.actions[0].reason, 'issue 999 not found');
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [['comment', 'pr', 8], ['comment', 'issue', 6], ['addLabel', 'pr', 8]]);
});

test('the CLI prints the result and exits 1 when any PR errored', () => {
  const dir = fakeGh({
    [`pr list --repo ${REPO} --state open --limit 500 --json number,headRefName,isCrossRepository,isDraft`]: [{ number: 7, headRefName: 'claude/5-x', isCrossRepository: false, isDraft: false }],
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
  const red = fakeDeps({ prs: [basePr({ labels: ['ready'], statusCheckRollup: [run('test', 'FAILURE'), run('claude-review', 'SUCCESS')] })], comments: verdictComment('accepted') });
  await runReady({ repo: REPO, config, now: NOW }, red.deps);
  assert.deepEqual(red.calls, [['removeLabel', 'pr', 7, 'ready'], ['addLabel', 'pr', 7, 'claude-fix']]);
  const pending = fakeDeps({ prs: [basePr({ labels: ['ready'], statusCheckRollup: [run('test', 'SUCCESS'), { __typename: 'CheckRun', name: 'claude-review', status: 'IN_PROGRESS', conclusion: null }] })], comments: [] });
  const r = await runReady({ repo: REPO, config, now: NOW }, pending.deps);
  assert.deepEqual([r.actions[0].action, pending.calls], ['wait', [['removeLabel', 'pr', 7, 'ready']]]);
});

const lockAt = (iso) => normalizeComments([{ id: 50, user: { login: 'claude[bot]' }, author_association: 'NONE', created_at: iso, body: `**[claude-pipeline]** lock · ${iso} · local` }]);
const revision = verdictComment('revision-needed', [{ file: 'a', line: 1, severity: 'Important', kind: 'unambiguous', problem: 'p', impact: 'i', correction: 'c' }]);
const reviewRed = () => basePr({ labels: ['ready'], statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });

test('a fix, update or needs-decision waits with no writes at all while the linked issue has a fresh claude-working lock', async () => {
  const working = issue(['claude', 'claude-working'], lockAt('2026-10-07T09:30:00Z'));
  for (const [pr, comments] of [
    [reviewRed(), revision],
    [basePr({ labels: ['ready'], mergeStateStatus: 'BEHIND' }), verdictComment('accepted')],
    [reviewRed(), verdictComment('human-decision-needed', [judgmentFinding])],
  ]) {
    const { deps, calls } = fakeDeps({ prs: [pr], comments, issue: working });
    const r = await runReady({ repo: REPO, config, now: NOW }, deps);
    assert.deepEqual(r.actions.map((a) => [a.action, a.reason]), [['wait', 'fix run in progress (claude-working on issue 5)']]);
    assert.deepEqual(calls, []);
  }
});

test('without claude-working, or with a lock older than lockTtlHours, the fix request goes ahead', async () => {
  for (const iss of [issue(['claude'], lockAt('2026-10-07T09:30:00Z')), issue(['claude', 'claude-working'], lockAt('2026-10-07T05:00:00Z'))]) {
    const { deps, calls } = fakeDeps({ prs: [reviewRed()], comments: revision, issue: iss });
    const r = await runReady({ repo: REPO, config, now: NOW }, deps);
    assert.equal(r.actions[0].action, 'fix');
    assert.deepEqual(calls, [['removeLabel', 'pr', 7, 'ready'], ['addLabel', 'pr', 7, 'claude-fix']]);
  }
});

test('a PR without a linked issue is not gated by any lock', async () => {
  const { deps, calls } = fakeDeps({ prs: [basePr({ body: 'no link', statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] })], comments: revision });
  deps.fetchIssue = () => { throw new Error('should not fetch'); };
  const r = await runReady({ repo: REPO, config, now: NOW }, deps);
  assert.equal(r.actions[0].action, 'fix');
  assert.deepEqual(calls, [['addLabel', 'pr', 7, 'claude-fix']]);
});
