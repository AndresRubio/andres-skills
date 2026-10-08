import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkState, decideReady, readyReport, issueNumberFromBody, matchesProtected } from '../skills/ship/scripts/lib/ready.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';

const HEAD = 'a'.repeat(40);
const config = validateConfig({ tracker: { type: 'github' }, ciChecks: ['test'], mergeDeploys: false, protectedPaths: ['src/storage.ts'] });
const run = (name, conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, conclusion, status });
const ctx = (context, state) => ({ __typename: 'StatusContext', context, state });
const pr = (over = {}) => ({
  number: 7, headRefName: 'claude/5-fix', headRefOid: HEAD, isDraft: false, isCrossRepository: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'SUCCESS')], body: 'Fixes #5', ...over,
});
const accepted = { verdict: 'accepted', head: HEAD, findings: [], diffRisk: [] };
const judgment = { file: 'src/list.ts', line: 1, severity: 'Critical', kind: 'judgment', problem: 'p', impact: 'i', correction: 'c' };

test('checkState reads check runs and status contexts by name', () => {
  const rollup = [run('test', 'SUCCESS'), run('lint', 'FAILURE'), run('build', null, 'IN_PROGRESS'), run('e2e', 'SKIPPED'), ctx('ci/other', 'ERROR')];
  assert.equal(checkState(rollup, 'test'), 'success');
  assert.equal(checkState(rollup, 'lint'), 'failure');
  assert.equal(checkState(rollup, 'build'), 'pending');
  assert.equal(checkState(rollup, 'e2e'), 'pending');
  assert.equal(checkState(rollup, 'ci/other'), 'failure');
  assert.equal(checkState(rollup, 'nope'), 'missing');
  assert.equal(checkState([run('test', 'TIMED_OUT')], 'test'), 'failure');
  assert.equal(checkState([run('test', 'CANCELLED')], 'test'), 'failure');
  assert.equal(checkState([run('test', 'NEUTRAL')], 'test'), 'pending');
});

test('decideReady skips drafts, forks and non-pipeline branches', () => {
  assert.equal(decideReady({ pr: pr({ isDraft: true }), config, verdict: accepted }).action, 'skip');
  assert.equal(decideReady({ pr: pr({ isCrossRepository: true }), config, verdict: accepted }).action, 'skip');
  assert.equal(decideReady({ pr: pr({ headRefName: 'feature/x' }), config, verdict: accepted }).action, 'skip');
});

test('decideReady skips non-key branch shapes like claude/experiment', () => {
  assert.equal(decideReady({ pr: pr({ headRefName: 'claude/experiment' }), config, verdict: accepted }).action, 'skip');
  assert.equal(decideReady({ pr: pr({ headRefName: 'claude/experiment' }), config, verdict: accepted }).reason, 'not a pipeline branch');
  assert.deepEqual(decideReady({ pr: pr({ headRefName: 'claude/5' }), config, verdict: accepted }), { action: 'ready' });
});

test('a failed claude-review routes by verdict; a missing verdict is a human decision', () => {
  const failed = pr({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });
  const hd = decideReady({ pr: failed, config, verdict: { ...accepted, verdict: 'human-decision-needed', findings: [judgment] } });
  assert.equal(hd.action, 'needs-decision');
  assert.deepEqual(hd.findings, [judgment]);
  assert.equal(decideReady({ pr: failed, config, verdict: { ...accepted, verdict: 'revision-needed' } }).action, 'fix');
  assert.equal(decideReady({ pr: failed, config, verdict: { ...accepted, verdict: 'revision-needed' } }).reason, 'review');
  const missing = decideReady({ pr: failed, config, verdict: null });
  assert.equal(missing.action, 'needs-decision');
  assert.match(missing.reason, /no verdict/);
});

test('red CI asks for a fix; pending checks wait; a missing required check waits', () => {
  assert.deepEqual(decideReady({ pr: pr({ statusCheckRollup: [run('test', 'FAILURE'), run('claude-review', 'SUCCESS')] }), config, verdict: accepted }), { action: 'fix', reason: 'ci', failing: ['test'] });
  assert.equal(decideReady({ pr: pr({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', null, 'QUEUED')] }), config, verdict: accepted }).action, 'wait');
  assert.equal(decideReady({ pr: pr({ statusCheckRollup: [run('claude-review', 'SUCCESS')] }), config, verdict: accepted }).action, 'wait');
});

test('review check failure + CI failure: routes by verdict first, never plain fix/ci', () => {
  const both = pr({ statusCheckRollup: [run('test', 'FAILURE'), run('claude-review', 'FAILURE')] });
  const hd = decideReady({ pr: both, config, verdict: { ...accepted, verdict: 'human-decision-needed', findings: [judgment] } });
  assert.equal(hd.action, 'needs-decision');
  const rev = decideReady({ pr: both, config, verdict: { ...accepted, verdict: 'revision-needed' } });
  assert.equal(rev.action, 'fix');
  assert.equal(rev.reason, 'review');
});

test('StatusContext SUCCESS is success and PENDING is pending', () => {
  const rollup = [ctx('ci/github', 'SUCCESS'), ctx('ci/pending', 'PENDING')];
  assert.equal(checkState(rollup, 'ci/github'), 'success');
  assert.equal(checkState(rollup, 'ci/pending'), 'pending');
});

test('review check pending with revision-needed verdict waits', () => {
  const pending = pr({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', null, 'QUEUED')] });
  assert.equal(decideReady({ pr: pending, config, verdict: { ...accepted, verdict: 'revision-needed' } }).action, 'wait');
});

test('duplicate check names: only the newest entry counts (final review I7)', () => {
  const at = (entry, startedAt, completedAt) => ({ ...entry, startedAt, completedAt });
  // A re-run's newer success replaces the old failure, in either order in the rollup.
  assert.equal(checkState([at(run('test', 'FAILURE'), '2026-10-07T09:00:00Z', '2026-10-07T09:05:00Z'), at(run('test', 'SUCCESS'), '2026-10-07T10:00:00Z', '2026-10-07T10:05:00Z')], 'test'), 'success');
  assert.equal(checkState([at(run('test', 'SUCCESS'), '2026-10-07T10:00:00Z', '2026-10-07T10:05:00Z'), at(run('test', 'FAILURE'), '2026-10-07T09:00:00Z', '2026-10-07T09:05:00Z')], 'test'), 'success');
  // The reverse: a newer failure wins over an older success.
  assert.equal(checkState([at(run('test', 'SUCCESS'), '2026-10-07T09:00:00Z', '2026-10-07T09:05:00Z'), at(run('test', 'FAILURE'), '2026-10-07T10:00:00Z', '2026-10-07T10:05:00Z')], 'test'), 'failure');
  // A re-run still in progress (gh prints the zero time for completedAt) ranks by startedAt.
  assert.equal(checkState([at(run('test', 'FAILURE'), '2026-10-07T09:00:00Z', '2026-10-07T09:05:00Z'), at(run('test', null, 'IN_PROGRESS'), '2026-10-07T10:00:00Z', '0001-01-01T00:00:00Z')], 'test'), 'pending');
  // Status contexts rank by createdAt; an entry without a timestamp ranks oldest.
  const sc = (state, createdAt) => ({ ...ctx('ci/x', state), createdAt });
  assert.equal(checkState([sc('FAILURE', '2026-10-07T09:00:00Z'), sc('SUCCESS', '2026-10-07T10:00:00Z')], 'ci/x'), 'success');
  assert.equal(checkState([at(run('test', 'SUCCESS'), '2026-10-07T10:00:00Z', '2026-10-07T10:05:00Z'), run('test', 'FAILURE')], 'test'), 'success');
});

test('duplicate check names without any timestamps keep the old rule: any failure wins', () => {
  assert.equal(checkState([run('test', 'FAILURE'), run('test', 'SUCCESS')], 'test'), 'failure');
  assert.equal(checkState([run('test', 'SUCCESS'), run('test', null, 'IN_PROGRESS')], 'test'), 'pending');
});

test('a green verdict check with a non-accepted comment is never ready', () => {
  const r = decideReady({ pr: pr(), config, verdict: { ...accepted, verdict: 'revision-needed' } });
  assert.equal(r.action, 'fix');
  assert.equal(decideReady({ pr: pr(), config, verdict: null }).action, 'needs-decision');
});

test('behind base updates; conflict asks for a fix; both drop ready', () => {
  const behind = decideReady({ pr: pr({ mergeStateStatus: 'BEHIND', labels: ['ready'] }), config, verdict: accepted });
  assert.deepEqual(behind, { action: 'update', reason: 'behind base', removeReady: true });
  const conflict = decideReady({ pr: pr({ mergeable: 'CONFLICTING', labels: ['ready'] }), config, verdict: accepted });
  assert.deepEqual(conflict, { action: 'fix', reason: 'conflict', removeReady: true });
});

test('a merge state GitHub has not computed yet waits instead of reading as ready (final review I8)', () => {
  assert.deepEqual(decideReady({ pr: pr({ mergeable: 'UNKNOWN' }), config, verdict: accepted }), { action: 'wait', reason: 'merge state not computed yet' });
  assert.deepEqual(decideReady({ pr: pr({ mergeStateStatus: 'UNKNOWN', labels: ['ready'] }), config, verdict: accepted }), { action: 'wait', reason: 'merge state not computed yet', removeReady: true });
  assert.deepEqual(decideReady({ pr: pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND' }), config, verdict: accepted }).action, 'wait');
});

test('green, accepted, current and clean is ready; already labelled is already-ready', () => {
  assert.deepEqual(decideReady({ pr: pr(), config, verdict: accepted }), { action: 'ready' });
  assert.deepEqual(decideReady({ pr: pr({ labels: ['ready'] }), config, verdict: accepted }), { action: 'already-ready' });
});

test('matchesProtected handles ** and * and the always-protected paths', () => {
  assert.equal(matchesProtected('src/storage.ts', config.protectedPathsEffective), true);
  assert.equal(matchesProtected('.github/workflows/ci.yml', config.protectedPathsEffective), true);
  assert.equal(matchesProtected('.claude/pipeline.json', config.protectedPathsEffective), true);
  assert.equal(matchesProtected('src/list.ts', config.protectedPathsEffective), false);
  assert.equal(matchesProtected('src/auth/x/y.ts', ['src/auth/**']), true);
  assert.equal(matchesProtected('src/authz.ts', ['src/auth/**']), false);
  assert.equal(matchesProtected('a/b.ts', ['a/*.ts']), true);
  assert.equal(matchesProtected('a/c/b.ts', ['a/*.ts']), false);
});

test('issueNumberFromBody reads closing keywords', () => {
  assert.equal(issueNumberFromBody('**[claude-pipeline]** report · x · y\nFixes #12\n'), 12);
  assert.equal(issueNumberFromBody('Closes #3'), 3);
  assert.equal(issueNumberFromBody('resolves #44 and more'), 44);
  assert.equal(issueNumberFromBody('see #9'), null);
  assert.equal(issueNumberFromBody(null), null);
});

test('readyReport requires a valid parsed verdict', () => {
  assert.throws(() => readyReport({ pr: pr({ url: 'https://github.com/o/r/pull/7' }), config, verdict: null, changedFiles: [], marker: 'test', runSummary: null }), /readyReport needs a parsed verdict/);
  assert.throws(() => readyReport({ pr: pr({ url: 'https://github.com/o/r/pull/7' }), config, verdict: { verdict: null }, changedFiles: [], marker: 'test', runSummary: null }), /readyReport needs a parsed verdict/);
});

test('readyReport lists checks, flags, diff-risk hits and links, and never a gate', () => {
  const marker = '**[claude-pipeline]** ready · 2026-10-07T10:00:00Z · local';
  const verdict = { ...accepted, diffRisk: [{ rule: 'dependency-changed', file: 'package.json', detail: 'manifest changed' }], at: '2026-10-07T09:00:00Z', run: 'https://x/runs/9' };
  const text = readyReport({ pr: pr({ url: 'https://github.com/o/r/pull/7' }), config: { ...config, mergeDeploys: true }, verdict, changedFiles: ['src/storage.ts', 'src/list.ts'], marker, runSummary: 'ship run: 41 min, $3.20' });
  assert.equal(text.split('\n')[0], marker);
  assert.match(text, /\*\*Ready to merge\*\* at head `aaaaaaa`/);
  assert.match(text, /- `test`: success\n- `claude-review`: success/);
  assert.match(text, /verdict `accepted` \(https:\/\/x\/runs\/9\)/);
  assert.match(text, /## Review with care\n/);
  assert.match(text, /- Merging deploys \(`mergeDeploys` is true\)\./);
  assert.match(text, /- Protected path changed: `src\/storage\.ts`/);
  assert.match(text, /- Diff risk — dependency-changed: `package\.json` — manifest changed/);
  assert.match(text, /\[evidence\.md\]\(https:\/\/github\.com\/o\/r\/blob\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/docs\/pipeline\/5\/evidence\.md\)/);
  assert.match(text, /ship run: 41 min, \$3\.20/);
  assert.doesNotMatch(text, /ship-it/);
  const quiet = readyReport({ pr: pr({ url: 'https://github.com/o/r/pull/7' }), config, verdict: accepted, changedFiles: ['src/list.ts'], marker, runSummary: null });
  assert.match(quiet, /## Review with care\nNothing flagged\./);
});

test('decideReady asks for the ready label to be removed on every non-green decision when the PR carries it', () => {
  const labelled = (over = {}) => pr({ labels: ['ready'], ...over });
  const failedReview = labelled({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', 'FAILURE')] });
  assert.equal(decideReady({ pr: failedReview, config, verdict: null }).removeReady, true);
  assert.equal(decideReady({ pr: failedReview, config, verdict: { ...accepted, verdict: 'human-decision-needed', findings: [judgment] } }).removeReady, true);
  assert.equal(decideReady({ pr: failedReview, config, verdict: { ...accepted, verdict: 'revision-needed' } }).removeReady, true);
  assert.equal(decideReady({ pr: labelled({ statusCheckRollup: [run('test', 'FAILURE'), run('claude-review', 'SUCCESS')] }), config, verdict: accepted }).removeReady, true);
  assert.equal(decideReady({ pr: labelled({ statusCheckRollup: [run('test', 'SUCCESS'), run('claude-review', null, 'QUEUED')] }), config, verdict: accepted }).removeReady, true);
  assert.equal(decideReady({ pr: labelled(), config, verdict: accepted }).removeReady, undefined);
  assert.equal(decideReady({ pr: pr({ statusCheckRollup: [run('test', 'FAILURE'), run('claude-review', 'SUCCESS')] }), config, verdict: accepted }).removeReady, undefined);
});

test('a queued re-run with no timestamps outranks an older failure (final review re-review)', () => {
  const failed = { __typename: 'CheckRun', name: 'claude-review', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-07T09:00:00Z', completedAt: '2026-10-07T09:05:00Z' };
  const queued = { __typename: 'CheckRun', name: 'claude-review', status: 'QUEUED', conclusion: null, startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' };
  assert.equal(checkState([failed, queued], 'claude-review'), 'pending');
  assert.equal(checkState([queued, failed], 'claude-review'), 'pending');
});
