import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSampled, validateScore, formatScoreBody, parseScoreBody, latestScore } from '../skills/ship/scripts/lib/score.mjs';
import { runCli } from './helpers/cli.mjs';
import { tempDir } from './helpers/git.mjs';

const HEAD = 'b'.repeat(40);
const MK = '**[claude-pipeline]** score · 2026-10-20T10:00:00Z · local';
const score = { taskCompliance: 'partial', reviewQuality: 'actionable', reasons: { taskCompliance: 'adds an unrequested toggle --> scope', reviewQuality: 'every finding has a location and a fix' } };

test('one in four issues is sampled, deterministically', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8, 12, 13].map(isSampled), [false, false, false, true, false, true, true, false]);
  assert.equal(isSampled(null), false);
});

test('validateScore accepts the two rubrics and rejects anything else', () => {
  validateScore(score);
  assert.throws(() => validateScore({ ...score, taskCompliance: 'mostly' }), /taskCompliance/);
  assert.throws(() => validateScore({ ...score, reviewQuality: 'great' }), /reviewQuality/);
  assert.throws(() => validateScore({ ...score, reasons: {} }), /reasons/);
});

test('formatScoreBody and parseScoreBody round-trip, even with --> in a reason', () => {
  const body = formatScoreBody({ marker: MK, head: HEAD, score, model: 'claude-haiku-5-5' });
  assert.equal(body.split('\n')[0], MK);
  assert.match(body, /Task compliance: `partial`/);
  assert.match(body, /<!-- claude-pipeline-score \{.*\} -->$/);
  assert.equal(body.slice(body.indexOf('<!-- claude-pipeline-score')).match(/-->/g).length, 1, 'the reason cannot close the comment early');
  assert.deepEqual(parseScoreBody(body), { head: HEAD, ...score, model: 'claude-haiku-5-5' });
  assert.equal(parseScoreBody('hello'), null);
  assert.equal(parseScoreBody(`${MK}\n\n<!-- claude-pipeline-score {"taskCompliance":"great"} -->`), null);
});

test('latestScore reads only pipeline score comments', () => {
  const c = (id, pipeline, body) => ({ id, pipeline, marker: { kind: 'score' }, body });
  const older = formatScoreBody({ marker: MK, head: HEAD, score: { ...score, taskCompliance: 'non_compliant' } });
  const newer = formatScoreBody({ marker: MK, head: HEAD, score });
  assert.equal(latestScore([c(1, true, older), c(2, true, newer)]).taskCompliance, 'partial');
  assert.equal(latestScore([c(1, false, newer)]), null);
});

test('CLI score prints the comment body for a score file', () => {
  const file = path.join(tempDir('score-'), 'score.json');
  writeFileSync(file, JSON.stringify(score));
  const r = runCli(['score', '--head', HEAD, '--score-file', file, '--model', 'claude-haiku-5-5', '--now', '2026-10-20T10:00:00Z'], { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(parseScoreBody(r.json().body).reviewQuality, 'actionable');
  assert.equal(runCli(['score', '--head', 'xyz', '--score-file', file]).code, 2);
});
