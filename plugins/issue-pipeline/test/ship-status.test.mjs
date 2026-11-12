import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sessionStarted, holdsLock } from '../skills/ship/scripts/lib/ship-status.mjs';
import { parseMarker } from '../skills/ship/scripts/lib/marker.mjs';
import { normalizeComments } from '../skills/ship/scripts/lib/github.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { tempDir } from './helpers/git.mjs';

const REPO = 'o/r';
const COMMENTS = `api --paginate --slurp repos/${REPO}/issues/7/comments`;
const LABELS = `issue view 7 --repo ${REPO} --json labels`;
const POST = `issue comment 7 --repo ${REPO} --body-file BODY`;
const PARK = `issue edit 7 --repo ${REPO} --add-label needs-decision`;
const UNLOCK = `issue edit 7 --repo ${REPO} --remove-label pipeline-working`;
const ACTIONS = { GITHUB_RUN_ID: '99', GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com' };
const RUN = 'https://github.com/o/r/actions/runs/99';
const OTHER = 'https://github.com/o/r/actions/runs/98';

let clock = 0;
// A pipeline comment as the API returns it, each one a minute after the last.
const comment = (kind, run) => ({ id: ++clock, user: { login: 'claude[bot]' }, author_association: 'NONE', body: `**[issue-pipeline]** ${kind} · 2026-11-12T00:00:00Z · ${run}\n\ntext`, created_at: new Date(Date.UTC(2026, 10, 12, 0, clock)).toISOString() });
const labels = (...names) => ({ labels: names.map((name) => ({ name })) });

// A pipeline home as Setup leaves it: <home>/runs/run-XXXXXX.
function homeWith(...entries) {
  const home = tempDir('ship-status-');
  for (const entry of entries) mkdirSync(path.join(home, entry), { recursive: true });
  return home;
}

const status = (home, routes, key = '7') => {
  const dir = fakeGh(routes);
  const r = runCli(['ship-status', '--home', home, '--repo', REPO, '--key', key, '--post-missing'], { env: { PATH: `${dir}:${process.env.PATH}`, ISSUE_PIPELINE_BODY_FILE: 'BODY', ...ACTIONS }, cwd: dir });
  return { r, body: () => readFileSync(path.join(dir, 'BODY'), 'utf8') };
};

test('sessionStarted is true only when Setup left a run folder under the pipeline home', () => {
  assert.equal(sessionStarted(path.join(tempDir('ship-status-'), 'never-made')), false);
  assert.equal(sessionStarted(homeWith()), false);
  assert.equal(sessionStarted(homeWith('runs')), false);
  assert.equal(sessionStarted(homeWith('runs/review-a1B2c3')), false, 'a review run folder is not a ship run');
  const fileOnly = homeWith('runs');
  writeFileSync(path.join(fileOnly, 'runs', 'run-notadir'), '');
  assert.equal(sessionStarted(fileOnly), false, 'a file named like a run folder does not count');
  assert.equal(sessionStarted(homeWith('runs/run-a1B2c3')), true);
});

test('holdsLock is true only while the issue is locked and its newest lock comment is this run\'s', () => {
  const mine = normalizeComments([comment('lock', RUN)]);
  assert.equal(holdsLock(RUN, { labels: ['pipeline', 'pipeline-working'], comments: mine }), true);
  assert.equal(holdsLock(RUN, { labels: ['pipeline'], comments: mine }), false, 'the lock was released');
  const taken = normalizeComments([comment('lock', RUN), comment('report', RUN), comment('lock', OTHER)]);
  assert.equal(holdsLock(RUN, { labels: ['pipeline', 'pipeline-working'], comments: taken }), false, 'a later run holds it');
  assert.equal(holdsLock(RUN, { labels: ['pipeline-working'], comments: [] }), false, 'no lock comment at all');
});

test('CLI ship-status exits 0 for a session that started and released its lock', () => {
  const { r } = status(homeWith('runs/run-a1B2c3'), { [COMMENTS]: [[comment('lock', RUN), comment('report', RUN)]], [LABELS]: labels('pipeline') });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
});

test('CLI ship-status without --post-missing looks only at the run folder', () => {
  const r = runCli(['ship-status', '--home', homeWith('runs'), '--key', '7']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json(), { started: false, source: 'missing' });
  const ok = runCli(['ship-status', '--home', homeWith('runs/run-a1B2c3'), '--key', '7']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.json(), { started: true });
});

test('CLI ship-status --post-missing tells the issue the run did not start, parks it, and still exits 1', () => {
  // An earlier run's comment does not count as this run's.
  const { r, body } = status(homeWith('runs'), { [COMMENTS]: [[comment('lock', OTHER), comment('report', OTHER)]], [POST]: 'url', [PARK]: 'url' });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: false, source: 'posted' });
  assert.deepEqual({ kind: parseMarker(body()).kind, run: parseMarker(body()).run }, { kind: 'blocked', run: RUN });
  assert.match(body(), /did not start/);
  assert.match(body(), /https:\/\/github\.com\/o\/r\/actions\/runs\/99/);
});

test('CLI ship-status --post-missing counts a run that commented as started, wherever its run folder went', () => {
  const { r } = status(homeWith('runs'), { [COMMENTS]: [[comment('lock', RUN), comment('report', RUN)]], [LABELS]: labels('pipeline') });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
});

test('CLI ship-status --post-missing parks and unlocks an issue whose run stopped with the lock held', () => {
  const { r, body } = status(homeWith('runs/run-a1B2c3'), { [COMMENTS]: [[comment('lock', RUN)]], [LABELS]: labels('bug', 'pipeline', 'pipeline-working'), [POST]: 'url', [PARK]: 'url', [UNLOCK]: 'url' });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: true, finished: false, source: 'posted' });
  assert.deepEqual({ kind: parseMarker(body()).kind, run: parseMarker(body()).run }, { kind: 'blocked', run: RUN });
  assert.match(body(), /stopped with the lock held/);
});

test('CLI ship-status --post-missing leaves a lock that a later run holds', () => {
  const { r } = status(homeWith('runs/run-a1B2c3'), { [COMMENTS]: [[comment('lock', RUN), comment('report', RUN), comment('lock', OTHER)]], [LABELS]: labels('pipeline', 'pipeline-working') });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
});

test('CLI ship-status --post-missing posts nothing for a fix run keyed by its pull request', () => {
  const { r } = status(homeWith('runs'), {}, 'PR-7');
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: false, source: 'missing' });
  const started = status(homeWith('runs/run-a1B2c3'), {}, 'PR-7');
  assert.equal(started.r.code, 0, started.r.stderr);
  assert.deepEqual(started.r.json(), { started: true });
});

test('CLI ship-status refuses a key that is not a run key', () => {
  const r = runCli(['ship-status', '--home', homeWith('runs'), '--key', '7; rm -rf x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--key/);
});
