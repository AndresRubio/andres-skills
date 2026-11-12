import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sessionStarted } from '../skills/ship/scripts/lib/ship-status.mjs';
import { parseMarker } from '../skills/ship/scripts/lib/marker.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { tempDir } from './helpers/git.mjs';

const REPO = 'o/r';
const COMMENTS = `api --paginate --slurp repos/${REPO}/issues/7/comments`;
const ACTIONS = { GITHUB_RUN_ID: '99', GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com' };
const RUN = 'https://github.com/o/r/actions/runs/99';
const comment = (body) => ({ id: 1, user: { login: 'claude[bot]' }, author_association: 'NONE', body, created_at: '2026-11-12T00:00:00Z' });

// A pipeline home as Setup leaves it: <home>/runs/run-XXXXXX.
function homeWith(...entries) {
  const home = tempDir('ship-status-');
  for (const entry of entries) mkdirSync(path.join(home, entry), { recursive: true });
  return home;
}

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

test('CLI ship-status exits 0 for a session that started, and calls nothing', () => {
  const dir = fakeGh({});
  const r = runCli(['ship-status', '--home', homeWith('runs/run-a1B2c3'), '--repo', REPO, '--key', '7', '--post-missing'], { env: { PATH: `${dir}:${process.env.PATH}` }, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
});

test('CLI ship-status exits 1 for a session that never started', () => {
  const r = runCli(['ship-status', '--home', homeWith('runs'), '--key', '7']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json(), { started: false, source: 'missing' });
});

test('CLI ship-status --post-missing tells the issue the run did not start, parks it, and still exits 1', () => {
  const dir = fakeGh({
    // An earlier run's comment does not count as this run's.
    [COMMENTS]: [[comment('**[issue-pipeline]** lock · 2026-11-11T00:00:00Z · https://github.com/o/r/actions/runs/98\n\nRun started')]],
    [`issue comment 7 --repo ${REPO} --body-file BODY`]: 'https://github.com/o/r/issues/7#issuecomment-1',
    [`issue edit 7 --repo ${REPO} --add-label needs-decision`]: 'https://github.com/o/r/issues/7',
  });
  const env = { PATH: `${dir}:${process.env.PATH}`, ISSUE_PIPELINE_BODY_FILE: 'BODY', ...ACTIONS };
  const r = runCli(['ship-status', '--home', homeWith('runs'), '--repo', REPO, '--key', '7', '--post-missing'], { env, cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: false, source: 'posted' });
  const body = readFileSync(path.join(dir, 'BODY'), 'utf8');
  assert.deepEqual({ kind: parseMarker(body).kind, run: parseMarker(body).run }, { kind: 'blocked', run: RUN });
  assert.match(body, /did not start/);
  assert.match(body, /https:\/\/github\.com\/o\/r\/actions\/runs\/99/);
});

test('CLI ship-status --post-missing posts nothing when this run already commented on the issue', () => {
  // The run folder is looked for where the workflow says the home is. A run that commented started, wherever its folder went.
  const dir = fakeGh({ [COMMENTS]: [[comment(`**[issue-pipeline]** lock · 2026-11-12T00:00:00Z · ${RUN}\n\nRun started`)]] });
  const r = runCli(['ship-status', '--home', homeWith('runs'), '--repo', REPO, '--key', '7', '--post-missing'], { env: { PATH: `${dir}:${process.env.PATH}`, ...ACTIONS }, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { started: true });
});

test('CLI ship-status --post-missing posts nothing for a fix run keyed by its pull request', () => {
  const dir = fakeGh({});
  const r = runCli(['ship-status', '--home', homeWith('runs'), '--repo', REPO, '--key', 'PR-7', '--post-missing'], { env: { PATH: `${dir}:${process.env.PATH}` }, cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { started: false, source: 'missing' });
});

test('CLI ship-status refuses a key that is not a run key', () => {
  const r = runCli(['ship-status', '--home', homeWith('runs'), '--key', '7; rm -rf x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--key/);
});
