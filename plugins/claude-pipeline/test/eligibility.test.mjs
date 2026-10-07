import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkEligibility, hasNewTrustedReply } from '../skills/ship/scripts/lib/eligibility.mjs';
import { runLock } from '../skills/ship/scripts/lib/runs.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';
import { runCli } from './helpers/cli.mjs';
import { tempDir } from './helpers/git.mjs';

const NOW = new Date('2026-09-25T12:00:00Z');
const config = validateConfig({ tracker: { type: 'github' } });
const makeIssue = (over = {}) => ({
  number: 5, title: 't', body: '', state: 'open', isPullRequest: false,
  author: 'AndresRubio', authorAssociation: 'OWNER', labels: ['claude'],
  openBlockedBy: [], openSubIssues: [], comments: [], ...over,
});
const counted = (over = {}) => ({ self: { key: '5', lockedAt: null, lockId: null }, runs: [], ahead: [], maxParallel: 2, admitted: true, ...over });
const run = (key) => ({ key, issue: /^\d+$/.test(key) ? Number(key) : null, pr: null, branch: null, title: null, body: null, textWithheld: false, lockedAt: '2026-09-25T11:00:00Z', lockId: Number(key) || 1, related: false });
const check = (issue, lane = 'github', extra = {}) => checkEligibility({ issue, config, lane, activeRuns: counted(), now: NOW, ...extra });
const marked = (kind, createdAt) => ({ author: 'AndresRubio', authorAssociation: 'OWNER', body: '', createdAt, marker: { kind, at: createdAt, run: 'local' } });
const reply = (createdAt, authorAssociation = 'OWNER') => ({ author: 'x', authorAssociation, body: 'answer', createdAt, marker: null });
const botMarked = (kind, createdAt) => ({ author: 'claude[bot]', authorAssociation: 'NONE', body: '', createdAt, marker: { kind, at: createdAt, run: 'local' } });

test('a labelled, open, owner-authored issue is eligible on a cloud lane', () => {
  assert.deepEqual(check(makeIssue()).reasons, []);
  assert.equal(check(makeIssue()).eligible, true);
});

test('missing claude label, closed, PR and untrusted author are each a reason', () => {
  assert.match(check(makeIssue({ labels: [] })).reasons.join(), /missing label claude/);
  assert.match(check(makeIssue({ state: 'closed' })).reasons.join(), /state is closed/);
  assert.match(check(makeIssue({ isPullRequest: true })).reasons.join(), /pull request/);
  assert.match(check(makeIssue({ author: 'stranger', authorAssociation: 'NONE' })).reasons.join(), /not trusted/);
});

test('needs-local issues run only on the local lane, and the local lane takes only them', () => {
  const local = makeIssue({ labels: ['claude', 'needs-local'] });
  assert.match(check(local, 'github').reasons.join(), /only on the local lane/);
  assert.equal(check(local, 'local').eligible, true);
  assert.match(check(makeIssue(), 'local').reasons.join(), /only needs-local/);
});

test('a fresh lock blocks; a stale lock does not', () => {
  const fresh = makeIssue({ labels: ['claude', 'claude-working'], comments: [marked('lock', '2026-09-25T11:00:00Z')] });
  assert.match(check(fresh).reasons.join(), /locked since/);
  const stale = makeIssue({ labels: ['claude', 'claude-working'], comments: [marked('lock', '2026-09-25T01:00:00Z')] });
  assert.equal(check(stale).eligible, true);
});

test('blocked issues, parents with open sub-issues and a full repo are not eligible', () => {
  assert.match(check(makeIssue({ openBlockedBy: [3] })).reasons.join(), /blocked by #3/);
  assert.match(check(makeIssue({ openSubIssues: [8] })).reasons.join(), /open sub-issues/);
});

test('the cap reason counts the runs ahead against maxParallel', () => {
  const full = counted({ runs: [run('7'), run('8')], ahead: ['7', '8'], admitted: false });
  assert.deepEqual(check(makeIssue(), 'github', { activeRuns: full }).reasons, ['maxParallel reached (2/2)']);
  const three = counted({ runs: [run('7'), run('8'), run('9')], ahead: ['7', '8', '9'], admitted: false });
  assert.match(check(makeIssue(), 'github', { activeRuns: three }).reasons.join(), /maxParallel reached \(3\/2\)/);
  assert.equal(check(makeIssue(), 'github', { activeRuns: counted({ runs: [run('7')], ahead: ['7'] }) }).eligible, true);
  const behind = counted({ runs: [run('7'), run('8'), run('9')], ahead: ['7', '8'], admitted: false });
  assert.deepEqual(check(makeIssue(), 'github', { activeRuns: behind }).reasons, ['maxParallel reached (2/2)']);
});

test('needs-decision resumes only on a newer trusted reply or claude-go', () => {
  const waiting = makeIssue({ labels: ['claude', 'needs-decision'], comments: [marked('questions', '2026-09-25T10:00:00Z')] });
  assert.match(check(waiting).reasons.join(), /needs-decision with no new reply/);
  assert.equal(check({ ...waiting, comments: [...waiting.comments, reply('2026-09-25T11:00:00Z')] }).eligible, true);
  assert.equal(check({ ...waiting, comments: [...waiting.comments, reply('2026-09-25T11:00:00Z', 'NONE')] }).eligible, false);
  assert.equal(check({ ...waiting, comments: [reply('2026-09-25T09:00:00Z'), ...waiting.comments] }).eligible, false);
  assert.equal(check({ ...waiting, labels: ['claude', 'needs-decision', 'claude-go'] }).eligible, true);
});

test('hasNewTrustedReply ignores marked comments', () => {
  assert.equal(hasNewTrustedReply(makeIssue({ comments: [marked('lock', '2026-09-25T10:00:00Z')] })), false);
});

test('hasNewTrustedReply ignores an untrusted marker when finding the last pipeline comment', () => {
  const waiting = makeIssue({
    labels: ['claude', 'needs-decision'],
    comments: [
      marked('questions', '2026-09-25T10:00:00Z'),
      reply('2026-09-25T11:00:00Z'),
      { author: 'stranger', authorAssociation: 'NONE', body: '', createdAt: '2026-09-25T11:30:00Z', marker: { kind: 'lock', at: '2026-09-25T11:30:00Z', run: 'local' } },
    ],
  });
  assert.equal(check(waiting).eligible, true);
});

test('a fresh lock posted by the pipeline bot blocks, even though its authorAssociation is not trusted', () => {
  const fresh = makeIssue({ labels: ['claude', 'claude-working'], comments: [botMarked('lock', '2026-09-25T11:00:00Z')] });
  assert.match(check(fresh).reasons.join(), /locked since/);
});

test('needs-decision: a bot question marker anchors lastMarked; only a reply newer than it counts', () => {
  const waitingOnBot = makeIssue({
    labels: ['claude', 'needs-decision'],
    comments: [reply('2026-09-25T09:00:00Z'), botMarked('questions', '2026-09-25T10:00:00Z')],
  });
  assert.equal(check(waitingOnBot).eligible, false);
  const resumed = { ...waitingOnBot, comments: [...waitingOnBot.comments, reply('2026-09-25T11:00:00Z')] };
  assert.equal(check(resumed).eligible, true);
});

test('a disabled pipeline blocks every lane', () => {
  const off = validateConfig({ tracker: { type: 'github' }, enabled: false });
  assert.match(checkEligibility({ issue: makeIssue(), config: off, lane: 'manual', now: NOW }).reasons.join(), /disabled/);
});

test('the manual lane checks only the kill switch and the lock', () => {
  const r = check(makeIssue({ labels: [], authorAssociation: 'NONE', openBlockedBy: [1] }), 'manual');
  assert.equal(r.eligible, true);
  const locked = makeIssue({ labels: ['claude-working'], comments: [marked('lock', '2026-09-25T11:00:00Z')] });
  assert.equal(check(locked, 'manual').eligible, false);
});

test('CLI eligibility validates the lane and reads files', () => {
  const dir = tempDir();
  const issueFile = path.join(dir, 'issue.json');
  const configFile = path.join(dir, 'config.json');
  const runsFile = path.join(dir, 'active-runs.json');
  writeFileSync(issueFile, JSON.stringify(makeIssue()));
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(runsFile, JSON.stringify(counted()));
  const ok = runCli(['eligibility', '--issue-file', issueFile, '--config-file', configFile, '--lane', 'github', '--active-runs-file', runsFile]);
  assert.equal(ok.json().eligible, true, ok.stderr);
  assert.equal(runCli(['eligibility', '--issue-file', issueFile, '--config-file', configFile, '--lane', 'moon', '--active-runs-file', runsFile]).code, 2);
  const full = path.join(dir, 'full.json');
  writeFileSync(full, JSON.stringify(counted({ runs: [run('7'), run('8')], ahead: ['7', '8'], admitted: false })));
  const capped = runCli(['eligibility', '--issue-file', issueFile, '--config-file', configFile, '--lane', 'github', '--active-runs-file', full]);
  assert.deepEqual(capped.json().reasons, ['maxParallel reached (2/2)'], capped.stderr);
});

test('CLI eligibility needs --active-runs-file on automatic lanes but not on the manual lane; --open-claude-prs is gone', () => {
  const dir = tempDir();
  const issueFile = path.join(dir, 'issue.json');
  const configFile = path.join(dir, 'config.json');
  writeFileSync(issueFile, JSON.stringify(makeIssue()));
  writeFileSync(configFile, JSON.stringify(config));
  for (const lane of ['github', 'linear', 'local']) {
    const missing = runCli(['eligibility', '--issue-file', issueFile, '--config-file', configFile, '--lane', lane]);
    assert.equal(missing.code, 2, `${lane}: ${missing.stderr}`);
    assert.match(missing.stderr, /--active-runs-file is required/);
  }
  const manual = runCli(['eligibility', '--issue-file', issueFile, '--config-file', configFile, '--lane', 'manual']);
  assert.equal(manual.code, 0, manual.stderr);
  assert.equal(manual.json().eligible, true);
  const old = runCli(['eligibility', '--issue-file', issueFile, '--config-file', configFile, '--lane', 'manual', '--open-claude-prs', '0']);
  assert.equal(old.code, 2);
  assert.match(old.stderr, /open-claude-prs/);
});

// --- D16: runs in progress ---

const deferredWait = (createdAt, line, id = 50) => ({
  id, author: 'AndresRubio', authorAssociation: 'OWNER', createdAt,
  body: `**[claude-pipeline]** deferred · ${createdAt} · local\n\n**Verdict:** \`wait\`\n\n${line}`,
  marker: { kind: 'deferred', at: createdAt, run: 'local' },
});

test('a waiting issue is held back while a listed run is in progress, and freed once none is', () => {
  const waiting = makeIssue({ comments: [deferredWait('2026-09-25T10:00:00Z', 'Waiting for: 7, 9')] });
  const busy = counted({ runs: [run('7'), run('8')], ahead: ['7', '8'] });
  assert.deepEqual(check(waiting, 'github', { activeRuns: busy }).reasons, ['waiting for 7 (still in progress)']);
  const both = counted({ runs: [run('9'), run('7')], ahead: ['9', '7'], maxParallel: 3 });
  assert.deepEqual(check(waiting, 'github', { activeRuns: both }).reasons, ['waiting for 7, 9 (still in progress)']);
  const done = counted({ runs: [run('8')], ahead: ['8'] });
  assert.deepEqual(check(waiting, 'github', { activeRuns: done }).reasons, []);
  assert.equal(check(waiting, 'github', { activeRuns: done }).eligible, true);
});

test('claude-go lifts a wait: a waiting issue with the label is eligible while its run is still in progress', () => {
  const comments = [deferredWait('2026-09-25T10:00:00Z', 'Waiting for: 7')];
  const busy = counted({ runs: [run('7')], ahead: ['7'] });
  assert.deepEqual(check(makeIssue({ labels: ['claude', 'claude-go'], comments }), 'github', { activeRuns: busy }).reasons, []);
  assert.deepEqual(check(makeIssue({ labels: ['claude'], comments }), 'github', { activeRuns: busy }).reasons, ['waiting for 7 (still in progress)']);
  const full = counted({ runs: [run('7'), run('8')], ahead: ['7', '8'], admitted: false });
  assert.deepEqual(check(makeIssue({ labels: ['claude', 'claude-go'], comments }), 'github', { activeRuns: full }).reasons, ['maxParallel reached (2/2)']);
});

test('the wait is held by any run in progress, not only by the runs ahead', () => {
  const waiting = makeIssue({ comments: [deferredWait('2026-09-25T10:00:00Z', 'Waiting for: 8')] });
  const behind = counted({ runs: [run('7'), run('8')], ahead: ['7'] });
  assert.deepEqual(check(waiting, 'github', { activeRuns: behind }).reasons, ['waiting for 8 (still in progress)']);
});

test('the manual lane ignores both the cap and the wait, and needs no activeRuns', () => {
  const waiting = makeIssue({ comments: [deferredWait('2026-09-25T10:00:00Z', 'Waiting for: 7')] });
  const full = counted({ runs: [run('7'), run('8')], ahead: ['7', '8'], admitted: false });
  assert.deepEqual(check(waiting, 'manual', { activeRuns: full }).reasons, []);
  assert.deepEqual(checkEligibility({ issue: waiting, config, lane: 'manual', now: NOW }).reasons, []);
});

test('automatic lanes throw without activeRuns, or with a count taken for another issue', () => {
  for (const lane of ['github', 'linear', 'local']) {
    assert.throws(() => checkEligibility({ issue: makeIssue(), config, lane, now: NOW }), /^Error: activeRuns is required for automatic lanes$/);
  }
  const other = counted({ self: { key: '6', lockedAt: null, lockId: null } });
  assert.throws(() => check(makeIssue(), 'github', { activeRuns: other }), /^Error: active runs were counted for #6, not #5$/);
});

test('an issue in its entering window still reads "locked since" through lockStatus', () => {
  const entering = makeIssue({
    labels: ['claude', 'claude-working'],
    comments: [
      { ...marked('lock', '2026-09-25T10:00:00Z'), id: 1 },
      { ...marked('report', '2026-09-25T10:30:00Z'), id: 2 },
    ],
  });
  assert.equal(runLock(entering, { ttlHours: config.lockTtlHours, now: NOW }).state, 'entering');
  assert.match(check(entering).reasons.join(), /locked since 2026-09-25T10:00:00Z/);
  assert.match(check(entering, 'manual').reasons.join(), /locked since 2026-09-25T10:00:00Z/);
});

test('hasNewTrustedReply: a reply stays new after later lock, deferred and stale-lock comments, but not after a later blocked', () => {
  const comments = [
    marked('questions', '2026-09-25T10:00:00Z'),
    reply('2026-09-25T10:30:00Z'),
    marked('lock', '2026-09-25T10:40:00Z'),
    marked('deferred', '2026-09-25T10:45:00Z'),
    botMarked('stale-lock', '2026-09-25T10:50:00Z'),
  ];
  assert.equal(hasNewTrustedReply(makeIssue({ comments })), true);
  assert.equal(hasNewTrustedReply(makeIssue({ comments: [...comments, marked('blocked', '2026-09-25T11:00:00Z')] })), false);
  const waiting = makeIssue({ labels: ['claude', 'needs-decision'], comments });
  assert.equal(check(waiting).eligible, true);
});

test('hasNewTrustedReply: a reminder asks nothing new, so a reply before it stays new', () => {
  const comments = [marked('questions', '2026-09-25T10:00:00Z'), reply('2026-09-25T10:30:00Z'), botMarked('reminder', '2026-09-25T11:00:00Z')];
  assert.equal(hasNewTrustedReply(makeIssue({ comments })), true);
});

test('hasNewTrustedReply: a reply in the same second as the last marked comment is not new', () => {
  const comments = [marked('questions', '2026-09-25T10:00:00Z'), reply('2026-09-25T10:00:00Z')];
  assert.equal(hasNewTrustedReply(makeIssue({ comments })), false);
  assert.equal(hasNewTrustedReply(makeIssue({ comments: [...comments, reply('2026-09-25T10:00:01Z')] })), true);
});
