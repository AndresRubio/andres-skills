import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateFixture, findLeaks, verdictFromComments } from '../acceptance/lib/evaluate.mjs';

const observed = (over = {}) => ({
  verdict: 'ready', pr: { url: 'u', headRefName: 'claude/5-x', body: 'Fixes #5' }, labels: ['claude'],
  commentKinds: ['lock', 'grade', 'report'], artifacts: ['research.md', 'grade.md', 'spec.md', 'plan.md', 'progress.md', 'evidence.md'],
  screenshots: 1, subIssues: 0, branchPushed: true, issueNumber: 5, ...over,
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
