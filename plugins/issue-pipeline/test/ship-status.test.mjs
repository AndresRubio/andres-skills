import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sessionStarted, lockLeft, endingEdits, sessionTrace } from '../skills/ship/scripts/lib/ship-status.mjs';
import { parseMarker } from '../skills/ship/scripts/lib/marker.mjs';
import { normalizeComments, PR_FIELDS } from '../skills/ship/scripts/lib/github.mjs';
import { sweepCandidates } from '../skills/ship/scripts/lib/sweep.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh, ghCalls } from './helpers/fake-gh.mjs';
import { tempDir } from './helpers/git.mjs';

const REPO = 'o/r';
const COMMENTS = `api --paginate --slurp repos/${REPO}/issues/7/comments`;
const LABELS = `issue view 7 --repo ${REPO} --json labels`;
const POST = `issue comment 7 --repo ${REPO} --body-file BODY`;
const PARK = `issue edit 7 --repo ${REPO} --add-label needs-decision`;
const UNLOCK = `issue edit 7 --repo ${REPO} --remove-label pipeline-working`;
const NO_GO = `issue edit 7 --repo ${REPO} --remove-label pipeline-go`;
const PR_VIEW = `pr view 12 --repo ${REPO} --json ${PR_FIELDS}`;
const ACTIONS = { GITHUB_RUN_ID: '99', GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com' };
const RUN = 'https://github.com/o/r/actions/runs/99';
const OTHER = 'https://github.com/o/r/actions/runs/98';
// This attempt began at minute 10. Comments are placed by their minute.
const SINCE = '2026-11-12T00:10:00Z';
const at = (minute) => new Date(Date.UTC(2026, 10, 12, 0, minute)).toISOString().replace('.000Z', 'Z');

// A pipeline comment as the API returns it.
const comment = (kind, run, minute) => ({ id: minute, user: { login: 'claude[bot]' }, author_association: 'NONE', body: `**[issue-pipeline]** ${kind} · ${at(minute)} · ${run}\n\ntext`, created_at: at(minute) });
const labels = (...names) => ({ labels: names.map((name) => ({ name })) });

// A pipeline home as Setup leaves it: <home>/runs/run-XXXXXX.
function homeWith(...entries) {
  const home = tempDir('ship-status-');
  for (const entry of entries) mkdirSync(path.join(home, entry), { recursive: true });
  return home;
}
const STARTED = () => homeWith('runs/run-a1B2c3');
const EMPTY = () => homeWith('runs');

function status(home, routes, { key = '7', since = SINCE, executionFile } = {}) {
  const dir = fakeGh(routes);
  const trace = executionFile ? ['--execution-file', executionFile] : [];
  const r = runCli(['ship-status', '--home', home, '--repo', REPO, '--key', key, '--since', since, ...trace, '--post-missing'], { env: { PATH: `${dir}:${process.env.PATH}`, ISSUE_PIPELINE_BODY_FILE: 'BODY', ...ACTIONS }, cwd: dir });
  return { r, calls: () => ghCalls(dir), body: () => readFileSync(path.join(dir, 'BODY'), 'utf8') };
}

// The session as claude-code-action writes it to $RUNNER_TEMP/claude-execution-output.json: the
// array of SDK messages. Only what sessionTrace reads is filled in.
const toolUse = (name, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: 'a secret thought' }, { type: 'tool_use', name, input: { command: 'cat .env' } }] } });
const result = (...denied) => ({ type: 'result', subtype: 'success', result: 'the last words', permission_denials: denied.map((tool_name) => ({ tool_name, tool_input: { command: 'cat .env' } })) });
function executionFile(messages) {
  const file = path.join(tempDir('ship-status-log-'), 'claude-execution-output.json');
  writeFileSync(file, typeof messages === 'string' ? messages : JSON.stringify(messages));
  return file;
}

test('sessionTrace reads tool names from the session log: the last calls of the main session and the refused ones', () => {
  const calls = ['Skill', 'Bash', 'Read', 'Bash', 'Bash', 'Write', 'Agent', 'Monitor'];
  const file = executionFile([{ type: 'system', subtype: 'init' }, ...calls.map((n) => toolUse(n)), toolUse('Grep', 'toolu_sub'), result('Monitor', 'Monitor', 'WebFetch')]);
  // Six calls at most, a subagent's calls left out, each refused tool once.
  assert.deepEqual(sessionTrace(file), { lastTools: ['Read', 'Bash', 'Bash', 'Write', 'Agent', 'Monitor'], denied: ['Monitor', 'WebFetch'] });
  // A name is the only thing taken from a call, and only a plain one: nothing a comment could be built from.
  assert.deepEqual(sessionTrace(executionFile([toolUse('Bash'), toolUse('x`\n**[issue-pipeline]** report'), result('ok', '<b>')])), { lastTools: ['Bash'], denied: ['ok'] });
  // Each of these could shape a comment if it got through: a code span closed early, a mention, markup.
  for (const odd of ['a`b', 'a b', 'a*b', '[a]', '@octocat', '<img>', 'a\nb', 'x'.repeat(81), '', 7, null, undefined, {}]) {
    assert.deepEqual(sessionTrace(executionFile([toolUse(odd), result(odd)])), { lastTools: [], denied: [] }, JSON.stringify(odd));
  }
  // Entries of the wrong shape are skipped, never thrown on: the command posts and edits labels after this.
  const wrong = [null, 7, 'text', [], { type: 'assistant' }, { type: 'assistant', message: null }, { type: 'assistant', message: { content: 'text' } },
    { type: 'assistant', message: { content: [null, 7, { type: 'tool_use' }] } }, { type: 'result' }, { type: 'result', permission_denials: 'no' },
    { type: 'result', permission_denials: [null, 7, {}] }, toolUse('Bash'), result('Monitor')];
  assert.deepEqual(sessionTrace(executionFile(wrong)), { lastTools: ['Bash'], denied: ['Monitor'] });
  // A log cannot make the comment long: twelve refused names at most, and a file over the size limit is not read.
  const many = Array.from({ length: 40 }, (_, i) => `Tool${i}`);
  assert.equal(sessionTrace(executionFile([result(...many)])).denied.length, 12);
  assert.equal(sessionTrace(executionFile([toolUse('Bash')]), { maxBytes: 10 }), null);
  assert.equal(sessionTrace(path.join(tempDir('ship-status-log-'), 'missing.json')), null);
  assert.equal(sessionTrace(executionFile('not json')), null);
  assert.equal(sessionTrace(executionFile({ type: 'result' })), null);
  assert.equal(sessionTrace(undefined), null);
});

test('sessionStarted is true only when Setup left a run folder under the pipeline home', () => {
  assert.equal(sessionStarted(path.join(tempDir('ship-status-'), 'never-made')), false);
  assert.equal(sessionStarted(homeWith()), false);
  assert.equal(sessionStarted(EMPTY()), false);
  assert.equal(sessionStarted(homeWith('runs/review-a1B2c3')), false, 'a review run folder is not a ship run');
  const fileOnly = EMPTY();
  writeFileSync(path.join(fileOnly, 'runs', 'run-notadir'), '');
  assert.equal(sessionStarted(fileOnly), false, 'a file named like a run folder does not count');
  assert.equal(sessionStarted(STARTED()), true);
});

test('lockLeft says how this attempt left the lock: free, held, or ended with the label still on', () => {
  const left = (names, list, opts = { since: SINCE }) => lockLeft(RUN, { labels: names, comments: normalizeComments(list), since: opts.since });
  const locked = ['pipeline', 'pipeline-working'];
  assert.deepEqual(left(locked, [comment('lock', RUN, 11)]), { left: 'held' });
  assert.deepEqual(left(['pipeline'], [comment('lock', RUN, 11)]), { left: 'free' }, 'the lock was released');
  assert.deepEqual(left(locked, [comment('lock', RUN, 11), comment('report', RUN, 12), comment('lock', OTHER, 13)]), { left: 'free' }, 'a later run holds it');
  assert.deepEqual(left(locked, []), { left: 'free' }, 'no lock comment at all');
  assert.deepEqual(left(locked, [comment('lock', RUN, 5)]), { left: 'free' }, 'an earlier attempt of this run took it');
  assert.deepEqual(left(locked, [comment('lock', RUN, 5)], {}), { left: 'held' }, 'without a start time every attempt counts');
  assert.deepEqual(left(locked, [comment('lock', RUN, 10)]), { left: 'held' }, 'a lock in the very second the attempt began is this attempt\'s');
  assert.deepEqual(left(locked, [comment('lock', RUN, 11), comment('report', RUN, 12)]), { left: 'ended', kind: 'report' });
  assert.deepEqual(left(locked, [comment('lock', RUN, 11), comment('grade', RUN, 12), comment('questions', RUN, 13)]), { left: 'ended', kind: 'questions' });
  assert.deepEqual(left(locked, [comment('lock', RUN, 11), comment('grade', RUN, 12)]), { left: 'held' }, 'a grade does not end a run');
  assert.deepEqual(left(locked, [comment('lock', RUN, 11), comment('report', OTHER, 12)]), { left: 'held' }, 'another run\'s report does not end this one');
  assert.deepEqual(left(locked, [comment('report', RUN, 10), comment('lock', RUN, 11)], {}), { left: 'held' }, 'a report from before the lock does not end it');
});

test('endingEdits finishes what each ending comment\'s procedure does to the labels', () => {
  const all = ['pipeline', 'pipeline-working', 'pipeline-go'];
  const park = ['--add-label', 'needs-decision'];
  const noGo = ['--remove-label', 'pipeline-go'];
  const unlock = ['--remove-label', 'pipeline-working'];
  // The stop procedure: needs-decision, then the lock, and pipeline-go with it.
  for (const kind of ['blocked', 'questions']) assert.deepEqual(endingEdits(kind, all), [park, noGo, unlock], kind);
  // Stage 10 releases the lock and a leftover pipeline-go.
  assert.deepEqual(endingEdits('report', all), [noGo, unlock]);
  // A back-off and a split release the lock and nothing else. Stage 3 says of the split: "This isn't
  // the stop procedure, and no needs-decision is added"; the parent waits for its sub-issues.
  for (const kind of ['deferred', 'split']) assert.deepEqual(endingEdits(kind, all), [unlock], kind);
  assert.deepEqual(endingEdits('blocked', ['pipeline', 'pipeline-working']), [park, unlock], 'no pipeline-go to remove');
});

test('CLI ship-status exits 0 for a session that started and released its lock, and changes nothing', () => {
  const { r, calls } = status(STARTED(), { [COMMENTS]: [[comment('lock', RUN, 11), comment('report', RUN, 12)]], [LABELS]: labels('pipeline') });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
  assert.deepEqual(calls(), [COMMENTS, LABELS]);
});

test('CLI ship-status without --post-missing looks only at the run folder', () => {
  const r = runCli(['ship-status', '--home', EMPTY(), '--key', '7']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json(), { started: false, source: 'missing' });
  const ok = runCli(['ship-status', '--home', STARTED(), '--key', '7']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.json(), { started: true });
});

test('CLI ship-status --post-missing tells the issue the run did not start, parks it, and still exits 1', () => {
  // An earlier run's comments do not count as this run's.
  // pipeline-go stays: a session that never started used no approval.
  const { r, calls, body } = status(EMPTY(), { [COMMENTS]: [[comment('lock', OTHER, 11), comment('report', OTHER, 12)]], [LABELS]: labels('pipeline', 'pipeline-go'), [POST]: 'url', [PARK]: 'url' });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: false, source: 'posted' });
  assert.deepEqual(calls(), [COMMENTS, LABELS, POST, PARK]);
  assert.deepEqual({ kind: parseMarker(body()).kind, run: parseMarker(body()).run }, { kind: 'blocked', run: RUN });
  assert.match(body(), /did not start/);
  assert.match(body(), /https:\/\/github\.com\/o\/r\/actions\/runs\/99/);
  assert.doesNotMatch(body(), /pipeline-go/, 'nothing to say about a label that stays');
});

test('CLI ship-status --post-missing does not let an earlier attempt of the same run stand in for this one', () => {
  // Attempt 1 ran to its report. Attempt 2, this one, began later and never reached Setup.
  const { r, calls } = status(EMPTY(), { [COMMENTS]: [[comment('lock', RUN, 3), comment('report', RUN, 5)]], [LABELS]: labels('pipeline'), [POST]: 'url', [PARK]: 'url' });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: false, source: 'posted' });
  assert.deepEqual(calls(), [COMMENTS, LABELS, POST, PARK]);
});

test('CLI ship-status --post-missing counts an attempt that commented as started, wherever its run folder went', () => {
  const { r, calls } = status(EMPTY(), { [COMMENTS]: [[comment('lock', RUN, 11), comment('report', RUN, 12)]], [LABELS]: labels('pipeline') });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
  assert.deepEqual(calls(), [COMMENTS, LABELS]);
});

test('CLI ship-status --post-missing parks and unlocks an issue whose attempt stopped with the lock held', () => {
  const { r, calls, body } = status(STARTED(), { [COMMENTS]: [[comment('lock', RUN, 11)]], [LABELS]: labels('bug', 'pipeline', 'pipeline-working', 'pipeline-go'), [POST]: 'url', [PARK]: 'url', [NO_GO]: 'url', [UNLOCK]: 'url' });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: true, finished: false, source: 'posted' });
  // The comment goes first, as in the stop procedure, and pipeline-go goes with the lock.
  assert.deepEqual(calls(), [COMMENTS, LABELS, POST, PARK, NO_GO, UNLOCK]);
  assert.deepEqual({ kind: parseMarker(body()).kind, run: parseMarker(body()).run }, { kind: 'blocked', run: RUN });
  assert.match(body(), /stopped with the lock held/);
});

test('CLI ship-status --post-missing says in its comment which tools the stopped session called last, and nothing else from its log', () => {
  const file = executionFile([toolUse('Bash'), toolUse('Agent'), result('Monitor')]);
  const routes = { [COMMENTS]: [[comment('lock', RUN, 11)]], [LABELS]: labels('pipeline', 'pipeline-working'), [POST]: 'url', [PARK]: 'url', [UNLOCK]: 'url' };
  const { r, body } = status(STARTED(), routes, { executionFile: file });
  assert.equal(r.code, 1, r.stderr);
  assert.match(body(), /\n\nFrom the session's log, tool names only: its last tool calls were `Bash`, `Agent`, and it was refused `Monitor`\.\n\nThe lock is released/);
  assert.equal(body().indexOf('**[issue-pipeline]** blocked'), 0, 'the marker stays first');
  assert.doesNotMatch(body(), /secret|\.env|last words/);
  // A log with no tool call and no refusal adds nothing.
  const quiet = status(STARTED(), routes, { executionFile: executionFile([{ type: 'system', subtype: 'init' }, result()]) });
  assert.doesNotMatch(quiet.body(), /session's log/);
  // No log, no line: the comment is the one from before.
  const plain = status(STARTED(), routes);
  assert.doesNotMatch(plain.body(), /tool calls/);
});

test('CLI ship-status --post-missing names the refused tools of a session that never started', () => {
  const file = executionFile([toolUse('Skill'), result('Skill')]);
  const { r, body } = status(EMPTY(), { [COMMENTS]: [[]], [LABELS]: labels('pipeline'), [POST]: 'url', [PARK]: 'url' }, { executionFile: file });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(body().indexOf('**[issue-pipeline]** blocked'), 0, 'the marker stays first');
  assert.match(body(), /did not start[^\n]*\n\nFrom the session's log, tool names only: its last tool calls were `Skill`, and it was refused `Skill`\.\n\nReply here once/);
});

test('CLI ship-status --post-missing leaves alone a lock that an earlier attempt of this run took', () => {
  // Attempt 1 died holding the lock. Attempt 2 stopped at stage 0 behind it and changed nothing.
  const { r, calls } = status(STARTED(), { [COMMENTS]: [[comment('lock', RUN, 3)]], [LABELS]: labels('pipeline', 'pipeline-working') });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
  assert.deepEqual(calls(), [COMMENTS, LABELS]);
});

test('CLI ship-status --post-missing finishes the labels of an attempt that posted its ending comment and stopped', () => {
  const ended = (kind, routes) => status(STARTED(), { [COMMENTS]: [[comment('lock', RUN, 11), comment(kind, RUN, 12)]], [LABELS]: labels('pipeline', 'pipeline-working', 'pipeline-go'), ...routes });
  const report = ended('report', { [NO_GO]: 'url', [UNLOCK]: 'url' });
  assert.equal(report.r.code, 0, report.r.stderr);
  assert.deepEqual(report.r.json(), { started: true, unlocked: true, after: 'report' });
  assert.deepEqual(report.calls(), [COMMENTS, LABELS, NO_GO, UNLOCK]);
  // A blocked comment without needs-decision would leave the owner's reply unrouted.
  const blocked = ended('blocked', { [PARK]: 'url', [NO_GO]: 'url', [UNLOCK]: 'url' });
  assert.equal(blocked.r.code, 0, blocked.r.stderr);
  assert.deepEqual(blocked.r.json(), { started: true, unlocked: true, after: 'blocked' });
  assert.deepEqual(blocked.calls(), [COMMENTS, LABELS, PARK, NO_GO, UNLOCK]);
  const deferred = ended('deferred', { [UNLOCK]: 'url' });
  assert.equal(deferred.r.code, 0, deferred.r.stderr);
  assert.deepEqual(deferred.calls(), [COMMENTS, LABELS, UNLOCK]);
});

test('CLI ship-status --post-missing applies the last ending comment when a back-off was followed by a stop', () => {
  // Stage 3's wait posts `deferred`; when the wait does not read back, hard rule 7 posts `blocked`.
  const { r, calls } = status(STARTED(), { [COMMENTS]: [[comment('lock', RUN, 11), comment('deferred', RUN, 12), comment('blocked', RUN, 13)]], [LABELS]: labels('pipeline', 'pipeline-working'), [PARK]: 'url', [UNLOCK]: 'url' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true, unlocked: true, after: 'blocked' });
  assert.deepEqual(calls(), [COMMENTS, LABELS, PARK, UNLOCK]);
});

test('CLI ship-status --post-missing parks a session that never started so that the sweep does not start it again', () => {
  // An earlier run crashed with the lock, and the issue carries pipeline-go. The sweep restarts a
  // stale lock, and pipeline-go lets an issue through needs-decision, so with both left on every
  // sweep would start the issue again and every failed start would post another comment.
  const before = ['pipeline', 'pipeline-working', 'pipeline-go'];
  const crashed = comment('lock', OTHER, 1);
  const { r, calls, body } = status(EMPTY(), { [COMMENTS]: [[crashed]], [LABELS]: labels(...before), [POST]: 'url', [PARK]: 'url', [NO_GO]: 'url' });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: false, source: 'posted' });
  assert.deepEqual(calls(), [COMMENTS, LABELS, POST, PARK, NO_GO]);
  // The owner is told, because a reply does not bring the label back.
  assert.match(body(), /`pipeline-go` was removed/);

  // The issue as those calls leave it, read by the sweep once the crashed run's lock is stale.
  const edits = calls().map((c) => c.match(/--(add|remove)-label (\S+)$/)).filter(Boolean);
  const after = edits.reduce((ls, [, verb, label]) => (verb === 'add' ? [...ls, label] : ls.filter((l) => l !== label)), before);
  const posted = { id: 20, user: { login: 'github-actions[bot]' }, author_association: 'NONE', body: body(), created_at: at(20) };
  const issue = {
    number: 7, title: 't', body: '', state: 'open', author: 'AndresRubio', authorAssociation: 'OWNER', isPullRequest: false,
    labels: after, openBlockedBy: [], openSubIssues: [], comments: normalizeComments([crashed, posted]), createdAt: at(0), labeledBy: 'AndresRubio',
  };
  const config = validateConfig({ tracker: { type: 'github' } });
  const sweep = sweepCandidates({ issues: [issue], prs: [], closedPrs: [], config, owner: 'AndresRubio', now: new Date('2026-11-12T06:00:00Z') });
  assert.deepEqual(sweep.start, []);
  assert.deepEqual(sweep.skipped.map((x) => x.why), ['needs-decision with no new reply']);
});

test('CLI ship-status --post-missing leaves another run\'s lock on an issue whose session never started', () => {
  // The lock is not this session's to remove, and there is no pipeline-go to take away.
  const { r, calls, body } = status(EMPTY(), { [COMMENTS]: [[comment('lock', OTHER, 1)]], [LABELS]: labels('pipeline', 'pipeline-working'), [POST]: 'url', [PARK]: 'url' });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(calls(), [COMMENTS, LABELS, POST, PARK]);
  assert.doesNotMatch(body(), /pipeline-go/);
});

test('CLI ship-status --post-missing leaves a lock that a later run holds', () => {
  const { r, calls } = status(STARTED(), { [COMMENTS]: [[comment('lock', RUN, 11), comment('report', RUN, 12), comment('lock', OTHER, 13)]], [LABELS]: labels('pipeline', 'pipeline-working') });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
  assert.deepEqual(calls(), [COMMENTS, LABELS]);
});

test('CLI ship-status --post-missing checks the issue behind a fix run keyed by its pull request', () => {
  const pr = { number: 12, headRefName: 'pipeline/7-wrong-month', labels: [] };
  const { r, calls } = status(STARTED(), { [PR_VIEW]: pr, [COMMENTS]: [[comment('lock', RUN, 11)]], [LABELS]: labels('pipeline', 'pipeline-working'), [POST]: 'url', [PARK]: 'url', [UNLOCK]: 'url' }, { key: 'PR-12' });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: true, finished: false, source: 'posted' });
  assert.deepEqual(calls(), [PR_VIEW, COMMENTS, LABELS, POST, PARK, UNLOCK]);
});

test('CLI ship-status --post-missing falls back to the run folder for a pull request that is not on a pipeline branch', () => {
  const pr = { number: 12, headRefName: 'feature/x', labels: [] };
  const missing = status(EMPTY(), { [PR_VIEW]: pr }, { key: 'PR-12' });
  assert.equal(missing.r.code, 1, missing.r.stderr);
  assert.deepEqual(missing.r.json(), { started: false, source: 'missing' });
  assert.deepEqual(missing.calls(), [PR_VIEW]);
  const started = status(STARTED(), { [PR_VIEW]: pr }, { key: 'PR-12' });
  assert.equal(started.r.code, 0, started.r.stderr);
  assert.deepEqual(started.r.json(), { started: true });
});

test('CLI ship-status --post-missing fails loudly when the pull request of a fix run cannot be read', () => {
  const { r, calls } = status(STARTED(), {}, { key: 'PR-12' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '', 'no result is printed: the lock was not checked');
  assert.match(r.stderr, /pr view 12/);
  assert.deepEqual(calls(), [PR_VIEW]);
});

test('CLI ship-status refuses a key that is not a run key and a start time that is not a date', () => {
  const key = runCli(['ship-status', '--home', EMPTY(), '--key', '7; rm -rf x']);
  assert.equal(key.code, 2);
  assert.match(key.stderr, /--key/);
  const since = runCli(['ship-status', '--home', EMPTY(), '--key', '7', '--since', 'yesterday']);
  assert.equal(since.code, 2);
  assert.match(since.stderr, /--since/);
});
