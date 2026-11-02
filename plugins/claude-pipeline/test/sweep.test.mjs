import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepCandidates, sweepReason, labelSenderTrusted } from '../skills/ship/scripts/lib/sweep.mjs';
import { latestDecision } from '../skills/ship/scripts/lib/runs.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';

const NOW = new Date('2026-10-20T12:00:00Z');
const config = validateConfig({ tracker: { type: 'github' }, maxParallel: 2 });
let nextId = 100;
const marked = (kind, at, text = '') => ({
  id: ++nextId, author: 'AndresRubio', authorAssociation: 'OWNER', createdAt: at,
  body: `**[claude-pipeline]** ${kind} · ${at} · local\n\n${text}`, marker: { kind, at, run: 'local' }, pipeline: true, trusted: true,
});
const reply = (at, body) => ({ id: ++nextId, author: 'AndresRubio', authorAssociation: 'OWNER', createdAt: at, body, marker: null, pipeline: false, trusted: true });
const makeIssue = (number, over = {}) => ({
  number, title: `t${number}`, body: '', state: 'open', author: 'AndresRubio', authorAssociation: 'OWNER', isPullRequest: false,
  labels: ['claude'], openBlockedBy: [], openSubIssues: [], comments: [], createdAt: '2026-10-20T08:00:00Z', labeledBy: 'AndresRubio', ...over,
});
const backOff = (number, createdAt = '2026-10-20T08:00:00Z') => makeIssue(number, {
  createdAt, comments: [marked('lock', '2026-10-20T10:00:00Z', 'Run started'), marked('deferred', '2026-10-20T10:01:00Z', 'Deferred: 2 runs are ahead of this one.')],
});
const pr = (number, headRefName) => ({ number, headRefName, isCrossRepository: false, title: `pr ${number}` });

test('latestDecision is the newest decision comment by id', () => {
  const issue = backOff(5);
  assert.equal(latestDecision(issue).marker.kind, 'deferred');
  assert.equal(latestDecision(makeIssue(6)), null);
});

test('sweepReason: deferred, never commented, stale lock, or nothing', () => {
  assert.equal(sweepReason(backOff(5), { config, now: NOW }), 'deferred');
  assert.equal(sweepReason(makeIssue(6), { config, now: NOW }), 'new');
  const stale = makeIssue(7, { labels: ['claude', 'claude-working'], comments: [marked('lock', '2026-10-20T07:00:00Z', 'Run started')] });
  assert.equal(sweepReason(stale, { config, now: NOW }), 'stale-lock');
  const graded = makeIssue(8, { comments: [marked('lock', '2026-10-20T10:00:00Z'), marked('grade', '2026-10-20T10:05:00Z'), marked('report', '2026-10-20T11:00:00Z')] });
  assert.equal(sweepReason(graded, { config, now: NOW }), null);
});

test('a backed-off issue starts when a slot is free', () => {
  const r = sweepCandidates({ issues: [backOff(5)], prs: [], closedPrs: [], config, now: NOW });
  assert.deepEqual([r.inProgress, r.slots, r.start], [0, 2, [5]]);
});

test('a stale lock from a crashed run is restarted', () => {
  const stale = makeIssue(7, { labels: ['claude', 'claude-working'], comments: [marked('lock', '2026-10-20T07:00:00Z', 'Run started')] });
  assert.deepEqual(sweepCandidates({ issues: [stale, stale], prs: [], closedPrs: [], config, now: NOW }).start, [7]);
});

test('no free slot: open claude/* PRs fill maxParallel', () => {
  const r = sweepCandidates({ issues: [backOff(5)], prs: [pr(1, 'claude/1-a'), pr(2, 'claude/2-b')], closedPrs: [], config, now: NOW });
  assert.deepEqual([r.inProgress, r.slots, r.start], [2, 0, []]);
  assert.deepEqual(r.skipped, [{ issue: 5, reason: 'deferred', why: 'no free slot' }]);
});

test('oldest first, up to the free slots', () => {
  const issues = [makeIssue(9, { createdAt: '2026-10-20T09:00:00Z' }), makeIssue(4, { createdAt: '2026-10-20T07:00:00Z' }), makeIssue(6, { createdAt: '2026-10-20T08:00:00Z' })];
  const r = sweepCandidates({ issues, prs: [pr(1, 'claude/1-a')], closedPrs: [], config, now: NOW });
  assert.deepEqual(r.start, [4]);
  assert.deepEqual(r.skipped.map((s) => [s.issue, s.why]), [[6, 'no free slot'], [9, 'no free slot']]);
});

test('never an issue with an open claude/* PR', () => {
  const r = sweepCandidates({ issues: [backOff(7)], prs: [pr(30, 'claude/7-x')], closedPrs: [], config: validateConfig({ tracker: { type: 'github' }, maxParallel: 3 }), now: NOW });
  assert.deepEqual(r.start, []);
  assert.equal(r.skipped[0].why, 'has an open claude/* PR');
});

test('never an issue whose PR was closed unmerged since its last report; a merge or an older close does not count', () => {
  const issue = makeIssue(8, { comments: [marked('report', '2026-10-20T09:00:00Z'), marked('deferred', '2026-10-20T11:00:00Z', 'Deferred: 2 runs are ahead of this one.')] });
  const closed = { number: 31, headRefName: 'claude/8-x', isCrossRepository: false, closedAt: '2026-10-20T10:00:00Z', mergedAt: null };
  assert.equal(sweepCandidates({ issues: [issue], prs: [], closedPrs: [closed], config, now: NOW }).skipped[0].why, 'PR #31 was closed unmerged');
  const older = { ...closed, closedAt: '2026-10-20T08:00:00Z' };
  assert.deepEqual(sweepCandidates({ issues: [issue], prs: [], closedPrs: [older], config, now: NOW }).start, [8]);
  const merged = { ...closed, mergedAt: '2026-10-20T10:00:00Z' };
  assert.deepEqual(sweepCandidates({ issues: [issue], prs: [], closedPrs: [merged], config, now: NOW }).start, [8]);
});

test('eligibility still applies: a wait whose run is in progress, needs-local, needs-decision without a reply', () => {
  const waiting = makeIssue(9, { comments: [marked('deferred', '2026-10-20T10:00:00Z', 'Waiting on #3.\n\nWaiting for: 3')] });
  const local = makeIssue(10, { labels: ['claude', 'needs-local'] });
  const parked = makeIssue(11, { labels: ['claude', 'needs-decision'], comments: [marked('lock', '2026-10-20T07:00:00Z'), marked('deferred', '2026-10-20T07:01:00Z', 'Deferred: 2 runs are ahead of this one.')] });
  const r = sweepCandidates({ issues: [waiting, local, parked], prs: [pr(3, 'claude/3-x')], closedPrs: [], config: validateConfig({ tracker: { type: 'github' }, maxParallel: 5 }), now: NOW });
  assert.deepEqual(r.start, []);
  assert.match(r.skipped.find((s) => s.issue === 9).why, /waiting for 3/);
  assert.match(r.skipped.find((s) => s.issue === 10).why, /needs-local/);
  assert.match(r.skipped.find((s) => s.issue === 11).why, /needs-decision with no new reply/);
  const answered = { ...parked, comments: [...parked.comments, reply('2026-10-20T11:00:00Z', 'Go ahead.')] };
  assert.deepEqual(sweepCandidates({ issues: [answered], prs: [], closedPrs: [], config, now: NOW }).start, [11]);
});

test('a new issue starts only when the person who labelled it is its author or the repo owner (the event route rule)', () => {
  const run = (issue, owner = 'AndresRubio') => sweepCandidates({ issues: [issue], prs: [], closedPrs: [], config, owner, now: NOW });
  // A triage user labels a trusted author's issue: the sweep does not start it.
  const byTriager = run(makeIssue(12, { author: 'friend', authorAssociation: 'COLLABORATOR', labeledBy: 'triager' }));
  assert.deepEqual(byTriager.start, []);
  assert.deepEqual(byTriager.skipped, [{ issue: 12, reason: 'new', why: 'label sender is not the issue author or the repo owner' }]);
  // The author labelling it, or the repo owner labelling a collaborator's issue, does start it.
  assert.deepEqual(run(makeIssue(13, { author: 'friend', authorAssociation: 'COLLABORATOR', labeledBy: 'friend' })).start, [13]);
  assert.deepEqual(run(makeIssue(14, { author: 'friend', authorAssociation: 'COLLABORATOR', labeledBy: 'AndresRubio' })).start, [14]);
  // An unknown labeller, or an unknown owner, never matches.
  assert.deepEqual(run(makeIssue(15, { labeledBy: null })).start, []);
  assert.deepEqual(run(makeIssue(16, { author: 'friend', authorAssociation: 'COLLABORATOR', labeledBy: 'AndresRubio' }), null).start, []);
  // A deferred issue already ran under a trusted labeller, so it is not asked again.
  assert.deepEqual(run({ ...backOff(17), labeledBy: undefined }).start, [17]);
  assert.equal(labelSenderTrusted({ author: 'a', labeledBy: 'a' }, undefined), true);
  assert.equal(labelSenderTrusted({ author: 'a', labeledBy: 'o' }, ''), false);
});

test('oldest first is stable: a missing createdAt sorts first, equal times go by issue number', () => {
  const wide = validateConfig({ tracker: { type: 'github' }, maxParallel: 9 });
  const order = (issues) => sweepCandidates({ issues, prs: [], closedPrs: [], config: wide, now: NOW }).start;
  assert.deepEqual(order([makeIssue(9, { createdAt: '2026-10-20T01:00:00Z' }), makeIssue(3, { createdAt: null }), makeIssue(2, { createdAt: null })]), [2, 3, 9]);
  const same = '2026-10-20T08:00:00Z';
  assert.deepEqual(order([makeIssue(8, { createdAt: same }), makeIssue(6, { createdAt: same }), makeIssue(7, { createdAt: same })]), [6, 7, 8]);
  assert.deepEqual(order([makeIssue(7, { createdAt: same }), makeIssue(8, { createdAt: same }), makeIssue(6, { createdAt: same })]), [6, 7, 8]);
});

test('a cross-repository PR on a claude/* branch neither blocks an issue nor counts as a run in progress', () => {
  const fork = { number: 40, headRefName: 'claude/7-x', isCrossRepository: true, title: 'from a fork' };
  const r = sweepCandidates({ issues: [backOff(7)], prs: [fork], closedPrs: [], config, now: NOW });
  assert.deepEqual([r.inProgress, r.start, r.skipped], [0, [7], []]);
  const closedFork = { number: 41, headRefName: 'claude/7-x', isCrossRepository: true, closedAt: '2026-10-20T11:30:00Z', mergedAt: null };
  assert.deepEqual(sweepCandidates({ issues: [backOff(7)], prs: [], closedPrs: [closedFork], config, now: NOW }).start, [7]);
});
