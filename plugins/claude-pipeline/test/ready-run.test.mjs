import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReady } from '../skills/ship/scripts/lib/ready-run.mjs';
import { formatVerdictBody } from '../skills/ship/scripts/lib/verdict.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';
import { normalizeComments } from '../skills/ship/scripts/lib/github.mjs';

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
    ['addLabel', 'pr', 7, 'ready'],
    ['comment', 'pr', 7, '**[claude-pipeline]** ready · 2026-10-07T10:00:00Z · local'],
    ['comment', 'issue', 5, '**[claude-pipeline]** ready · 2026-10-07T10:00:00Z · local'],
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
  assert.deepEqual([r.actions[0].action, r.actions[0].done, calls], ['ready', ['would add label ready', 'would comment on PR 7', 'would comment on issue 5'], []]);
});
