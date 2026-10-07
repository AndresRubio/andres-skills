import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { laneTarget } from '../skills/ship/scripts/lib/lane.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { tempDir } from './helpers/git.mjs';

const owner = { login: 'AndresRubio' };
const issue = (over = {}) => ({ number: 5, state: 'open', author_association: 'OWNER', user: owner, labels: [{ name: 'claude' }], ...over });
const labeled = (name, iss = issue(), sender = owner) => ({ action: 'labeled', label: { name }, issue: iss, sender });
const commented = (body, iss = issue({ labels: [{ name: 'claude' }, { name: 'needs-decision' }] }), assoc = 'OWNER') => ({ action: 'created', issue: iss, comment: { body, author_association: assoc, user: { login: assoc === 'OWNER' ? 'AndresRubio' : 'x' } } });
const prLabeled = (name, over = {}) => ({ action: 'labeled', label: { name }, pull_request: { number: 9, state: 'open', labels: [{ name }], head: { ref: 'claude/5-x', repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } }, ...over } });

test('a claude or claude-go label on a trusted open issue starts a ship run', () => {
  assert.deepEqual(laneTarget({ name: 'issues', payload: labeled('claude') }, { openPrs: [] }), { run: true, prompt: '/claude-pipeline:ship #5 --mode auto', key: '5', concurrency: 'ship-5' });
  assert.equal(laneTarget({ name: 'issues', payload: labeled('claude-go') }, { openPrs: [] }).run, true);
  assert.equal(laneTarget({ name: 'issues', payload: labeled('bug') }, { openPrs: [] }).run, false);
  assert.match(laneTarget({ name: 'issues', payload: labeled('claude', issue({ author_association: 'NONE' })) }, { openPrs: [] }).reason, /author/);
  assert.match(laneTarget({ name: 'issues', payload: labeled('claude', issue(), { login: 'stranger' }) }, { openPrs: [] }).reason, /sender/);
  assert.equal(laneTarget({ name: 'issues', payload: labeled('claude', issue({ state: 'closed' })) }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'issues', payload: labeled('claude', issue({ pull_request: {} })) }, { openPrs: [] }).run, false);
});

test('a trusted reply on a needs-decision issue resumes: a fix run when a pipeline PR is open, else a ship run', () => {
  const noPr = laneTarget({ name: 'issue_comment', payload: commented('go with option 2') }, { openPrs: [] });
  assert.deepEqual(noPr, { run: true, prompt: '/claude-pipeline:ship #5 --mode auto', key: '5', concurrency: 'ship-5' });
  const withPr = laneTarget({ name: 'issue_comment', payload: commented('hide, not delete') }, { openPrs: [{ number: 7, headRefName: 'claude/5-archive', isCrossRepository: false, labels: [] }] });
  assert.deepEqual(withPr, { run: true, prompt: '/claude-pipeline:ship 7 --mode auto --fix', key: '5', concurrency: 'ship-5' });
  assert.equal(laneTarget({ name: 'issue_comment', payload: commented('x', issue()) }, { openPrs: [] }).run, false, 'no needs-decision label');
  assert.equal(laneTarget({ name: 'issue_comment', payload: commented('x', undefined, 'NONE') }, { openPrs: [] }).run, false, 'untrusted commenter');
  assert.equal(laneTarget({ name: 'issue_comment', payload: commented('**[claude-pipeline]** blocked · 2026-10-07T10:00:00Z · local\n\nx') }, { openPrs: [] }).run, false, 'pipeline comment');
  const fork = laneTarget({ name: 'issue_comment', payload: commented('x') }, { openPrs: [{ number: 7, headRefName: 'claude/5-a', isCrossRepository: true, labels: [] }] });
  assert.equal(fork.prompt, '/claude-pipeline:ship #5 --mode auto', 'a fork PR is not a pipeline PR');
  assert.match(laneTarget({ name: 'issue_comment', payload: commented('x') }, { openPrs: [{ number: 7, headRefName: 'claude/5-a', isCrossRepository: false, labels: [{ name: 'needs-local' }] }] }).reason, /needs-local/, 'needs-local PR is not fixed on cloud');
  assert.match(laneTarget({ name: 'issue_comment', payload: commented('x', issue({ labels: [{ name: 'claude' }, { name: 'needs-decision' }, { name: 'needs-local' }] })) }, { openPrs: [] }).reason, /needs-local/, 'needs-local issue does not run');
});

test('intake labels on a needs-local issue are ignored', () => {
  assert.match(laneTarget({ name: 'issues', payload: labeled('claude', issue({ labels: [{ name: 'claude' }, { name: 'needs-local' }] })) }, { openPrs: [] }).reason, /needs-local/);
});

test('missing sender in issues.labeled blocks the run', () => {
  const payloadNoSender = { action: 'labeled', label: { name: 'claude' }, issue: issue(), sender: undefined };
  assert.match(laneTarget({ name: 'issues', payload: payloadNoSender }, { openPrs: [] }).reason, /sender/);
});

test('claude-fix on a same-repo pipeline PR starts a fix run; needs-local and forks are left alone', () => {
  assert.deepEqual(laneTarget({ name: 'pull_request', payload: prLabeled('claude-fix') }, { openPrs: [] }), { run: true, prompt: '/claude-pipeline:ship 9 --mode auto --fix', key: 'PR-9', concurrency: 'ship-PR-9' });
  assert.equal(laneTarget({ name: 'pull_request', payload: prLabeled('ready') }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'pull_request', payload: prLabeled('claude-fix', { labels: [{ name: 'claude-fix' }, { name: 'needs-local' }] }) }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'pull_request', payload: prLabeled('claude-fix', { head: { ref: 'claude/5-x', repo: { full_name: 'fork/r' } } }) }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'pull_request', payload: prLabeled('claude-fix', { head: { ref: 'feat/x', repo: { full_name: 'o/r' } } }) }, { openPrs: [] }).run, false);
});

test('other events never run', () => {
  assert.equal(laneTarget({ name: 'push', payload: {} }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'issues', payload: { action: 'opened', issue: issue() } }, { openPrs: [] }).run, false);
});

test('CLI lane-target reads the event file and lists PRs only for comments', () => {
  const dir = tempDir();
  const file = path.join(dir, 'event.json');
  writeFileSync(file, JSON.stringify(commented('decided')));
  const gh = fakeGh({ 'pr list --repo o/r --state open --limit 500 --json number,headRefName,isCrossRepository,labels': [{ number: 7, headRefName: 'claude/5-a', isCrossRepository: false, labels: [] }] });
  const r = runCli(['lane-target', '--event-file', file, '--repo', 'o/r', '--event-name', 'issue_comment'], { env: { PATH: `${gh}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().prompt, '/claude-pipeline:ship 7 --mode auto --fix');
  writeFileSync(file, JSON.stringify(labeled('claude')));
  const r2 = runCli(['lane-target', '--event-file', file, '--repo', 'o/r', '--event-name', 'issues'], { env: { PATH: `${fakeGh({})}:${process.env.PATH}` } });
  assert.equal(r2.json().prompt, '/claude-pipeline:ship #5 --mode auto');
});
