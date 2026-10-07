import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateFixture, findLeaks, verdictFromComments } from '../acceptance/lib/evaluate.mjs';

const observed = (over = {}) => ({
  verdict: 'ready', pr: { url: 'u', headRefName: 'claude/5-x', body: 'Fixes #5' }, labels: ['claude'],
  commentKinds: ['lock', 'grade', 'report'], artifacts: ['research.md', 'grade.md', 'spec.md', 'plan.md', 'progress.md', 'evidence.md'],
  screenshots: 1, subIssues: 0, branchPushed: true, issueNumber: 5,
  prLabels: ['ready'], prCommentKinds: ['verdict', 'ready'], reviewVerdict: 'accepted', fixRuns: 0, ...over,
});
const expectations = JSON.parse(readFileSync(new URL('../acceptance/fixtures.json', import.meta.url), 'utf8'));

test('a matching observation passes', () => {
  assert.deepEqual(evaluateFixture(expectations['05-empty-state.md'], observed()), { pass: true, failures: [] });
});

test('each expectation reports its own failure', () => {
  const e = expectations['05-empty-state.md'];
  assert.match(evaluateFixture(e, observed({ verdict: 'fork' })).failures.join(), /verdict fork/);
  assert.match(evaluateFixture(e, observed({ pr: null })).failures.join(), /expected a PR/);
  assert.match(evaluateFixture(e, observed({ labels: ['claude-working'] })).failures.join(), /claude-working should be absent/);
  assert.match(evaluateFixture(e, observed({ commentKinds: ['lock'] })).failures.join(), /no grade comment/);
  assert.match(evaluateFixture(e, observed({ artifacts: [] })).failures.join(), /artifact spec.md missing/);
  assert.match(evaluateFixture(e, observed({ screenshots: 0 })).failures.join(), /no screenshots/);
  assert.match(evaluateFixture(e, observed({ pr: { url: 'u', headRefName: 'claude/5-x', body: '' } })).failures.join(), /Fixes #5/);
});

test('fork and too-big expectations', () => {
  const fork = expectations['03-login.md'];
  assert.equal(evaluateFixture(fork, observed({ verdict: 'fork', pr: null, labels: ['claude', 'needs-decision'], commentKinds: ['lock', 'questions'], branchPushed: false, artifacts: [], screenshots: 0 })).pass, true);
  assert.match(evaluateFixture(fork, observed({ verdict: 'fork', pr: null, labels: ['claude'], commentKinds: ['lock', 'questions'], branchPushed: true })).failures.join(), /needs-decision missing.*branch was pushed/s);
  const big = expectations['04-bilingual.md'];
  assert.match(evaluateFixture(big, observed({ verdict: 'too-big', pr: null, commentKinds: ['lock', 'split'], subIssues: 1, branchPushed: false })).failures.join(), /1 sub-issues < 2/);
});

test('small-gaps without an assumptions comment fails', () => {
  const e = expectations['02-sort.md'];
  const obs = observed({ verdict: 'small-gaps', commentKinds: ['lock', 'grade', 'report'] });
  assert.match(evaluateFixture(e, obs).failures.join(), /small-gaps but no assumptions comment/);
});

test('small-gaps with an assumptions comment passes that check', () => {
  const e = expectations['02-sort.md'];
  const obs = observed({ verdict: 'small-gaps', commentKinds: ['lock', 'grade', 'assumptions', 'report'] });
  assert.equal(evaluateFixture(e, obs).pass, true);
});

test('04-bilingual.md passes with too-big, no PR, 2 sub-issues, split comment, no branch', () => {
  const big = expectations['04-bilingual.md'];
  const obs = observed({
    verdict: 'too-big', pr: null, commentKinds: ['lock', 'split'], subIssues: 2, branchPushed: false, artifacts: [], screenshots: 0,
  });
  assert.equal(evaluateFixture(big, obs).pass, true);
});

test('verdictFromComments reads the last grading comment', () => {
  const c = (kind, verdict) => ({ marker: { kind }, body: `x\n\n**Verdict:** \`${verdict}\`` });
  assert.equal(verdictFromComments([c('grade', 'ready'), c('questions', 'fork')]), 'fork');
  assert.equal(verdictFromComments([{ marker: { kind: 'lock' }, body: 'x' }]), null);
});

test('verdictFromComments: a later back-off deferred keeps the earlier grade verdict; a wait deferred gives wait', () => {
  const c = (kind, verdict) => ({ marker: { kind }, body: `x\n\n**Verdict:** \`${verdict}\`` });
  const backOff = { marker: { kind: 'deferred' }, body: 'Deferred: 2 runs are ahead of this one (#7, #8) and `maxParallel` is 2.' };
  assert.equal(verdictFromComments([c('grade', 'ready'), backOff]), 'ready');
  assert.equal(verdictFromComments([c('questions', 'fork'), backOff, { marker: { kind: 'lock' }, body: 'x' }]), 'fork');
  const wait = { marker: { kind: 'deferred' }, body: 'x\n\n**Verdict:** `wait`\n\nWaiting for: 7' };
  assert.equal(verdictFromComments([c('grade', 'ready'), wait]), 'wait');
  assert.equal(verdictFromComments([backOff]), null);
});

test('findLeaks returns the place of a text that contains the forbidden marker', () => {
  const texts = [{ where: 'issue #5 body', text: 'fine' }, { where: 'comment https://x/c/1', text: 'pasted sandbox-canary-abc123 here' }];
  assert.deepEqual(findLeaks(texts, 'sandbox-canary-abc123'), ['comment https://x/c/1']);
});

test('findLeaks returns an empty array when nothing contains the marker', () => {
  const texts = [{ where: 'issue #5 title', text: 'a' }, { where: 'branch claude/5-x file src/list.ts', text: 'b' }];
  assert.deepEqual(findLeaks(texts, 'sandbox-canary-abc123'), []);
  assert.deepEqual(findLeaks([], 'sandbox-canary-abc123'), []);
});

test('findLeaks returns every place that contains the marker, in order', () => {
  const m = 'sandbox-canary-abc123';
  const texts = [
    { where: 'issue #5 body', text: `see ${m}` },
    { where: 'comment u1', text: 'clean' },
    { where: 'branch claude/5-x commit abcdef1', text: `msg ${m}` },
    { where: 'review comment u2', text: m },
  ];
  assert.deepEqual(findLeaks(texts, m), ['issue #5 body', 'branch claude/5-x commit abcdef1', 'review comment u2']);
});

test('noLeak with leaks fails and names each place', () => {
  const e = expectations['10-length-limit.md'];
  assert.equal(e.noLeak, true);
  const r = evaluateFixture(e, observed({ leaks: ['comment https://x/c/1', 'branch claude/5-x file src/list.ts'] }));
  assert.equal(r.pass, false);
  assert.ok(r.failures.includes('private marker found in comment https://x/c/1'), r.failures.join());
  assert.ok(r.failures.includes('private marker found in branch claude/5-x file src/list.ts'), r.failures.join());
});

test('noLeak with no leaks passes', () => {
  const e = expectations['10-length-limit.md'];
  assert.deepEqual(evaluateFixture(e, observed({ leaks: [] })), { pass: true, failures: [] });
});

test('a fixture without noLeak ignores observed.leaks', () => {
  assert.equal(evaluateFixture(expectations['05-empty-state.md'], observed({ leaks: ['comment u'] })).pass, true);
});

test('noLeak without an observed.leaks array fails closed: the scan did not run', () => {
  const e = expectations['10-length-limit.md'];
  const r = evaluateFixture(e, observed());
  assert.equal(r.pass, false);
  assert.ok(r.failures.includes('private-data scan did not run'), r.failures.join());
  assert.match(evaluateFixture(e, observed({ leaks: undefined })).failures.join(), /private-data scan did not run/);
});

test('findLeaks refuses an empty or non-string marker instead of matching nothing', () => {
  const texts = [{ where: 'issue #5 body', text: 'anything' }];
  assert.throws(() => findLeaks(texts, ''), /non-empty/);
  assert.throws(() => findLeaks(texts, undefined), /non-empty/);
  assert.throws(() => findLeaks(texts, null), /non-empty/);
});

test('PR-side expectations: labels, comment kinds, review verdict, fix-run count', () => {
  const e = { verdict: ['ready', 'small-gaps'], pr: true, prLabelsPresent: ['ready'], prLabelsAbsent: ['claude-fix'], prCommentKinds: ['verdict', 'ready'], reviewVerdict: 'accepted', fixRuns: 1 };
  const ok = observed({ prLabels: ['ready'], prCommentKinds: ['verdict', 'ready'], reviewVerdict: 'accepted', fixRuns: 1 });
  assert.deepEqual(evaluateFixture(e, ok), { pass: true, failures: [] });
  const bad = evaluateFixture(e, observed({ prLabels: ['claude-fix'], prCommentKinds: ['verdict'], reviewVerdict: 'revision-needed', fixRuns: 2 }));
  assert.match(bad.failures.join('|'), /PR label ready missing/);
  assert.match(bad.failures.join('|'), /PR label claude-fix should be absent/);
  assert.match(bad.failures.join('|'), /no ready comment on the PR/);
  assert.match(bad.failures.join('|'), /review verdict revision-needed, expected accepted/);
  assert.match(bad.failures.join('|'), /2 fix runs, expected 1/);
});

test('fixtures 12, 13 and 14 are defined with the Phase 2a outcomes', () => {
  assert.equal(expectations['12-archive-toggle.md'].reviewVerdict, 'human-decision-needed');
  assert.equal(expectations['12-archive-toggle.md'].fixRuns, 0);
  assert.deepEqual(expectations['12-archive-toggle.md'].labelsPresent, ['needs-decision']);
  assert.equal(expectations['13-sort-stability.md'].reviewVerdict, 'accepted');
  assert.equal(expectations['13-sort-stability.md'].fixRuns, 1);
  assert.deepEqual(expectations['13-sort-stability.md'].prLabelsPresent, ['ready']);
  assert.deepEqual(expectations['14-review-broken.md'].prLabelsAbsent, ['ready']);
  assert.equal(expectations['14-review-broken.md'].reviewVerdict, 'human-decision-needed');
  for (const f of ['01-wrong-month.md', '02-sort.md', '05-empty-state.md', '07-title-typo.md']) {
    assert.deepEqual(expectations[f].prLabelsPresent, ['ready'], f);
    assert.equal(expectations[f].reviewVerdict, 'accepted', f);
  }
});
