import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkEligibility, hasNewTrustedReply } from '../skills/ship/scripts/lib/eligibility.mjs';
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
const check = (issue, lane = 'github', extra = {}) => checkEligibility({ issue, config, lane, openClaudePrs: 0, now: NOW, ...extra });
const marked = (kind, createdAt) => ({ author: 'AndresRubio', authorAssociation: 'OWNER', body: '', createdAt, marker: { kind, at: createdAt, run: 'local' } });
const reply = (createdAt, authorAssociation = 'OWNER') => ({ author: 'x', authorAssociation, body: 'answer', createdAt, marker: null });

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
  assert.match(check(makeIssue(), 'github', { openClaudePrs: 2 }).reasons.join(), /maxParallel reached \(2\/2\)/);
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
  writeFileSync(issueFile, JSON.stringify(makeIssue()));
  writeFileSync(configFile, JSON.stringify(config));
  const ok = runCli(['eligibility', '--issue-file', issueFile, '--config-file', configFile, '--lane', 'github', '--open-claude-prs', '0']);
  assert.equal(ok.json().eligible, true, ok.stderr);
  assert.equal(runCli(['eligibility', '--issue-file', issueFile, '--config-file', configFile, '--lane', 'moon']).code, 2);
});
