import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runDirFromCommand, recordSession, readMarker, markerContent } from '../skills/ship/scripts/lib/session.mjs';
import { tempDir } from './helpers/git.mjs';

test('runDirFromCommand finds the sourced vars.sh, only under <home>/runs', () => {
  const home = '/h/.claude-pipeline';
  assert.equal(runDirFromCommand(". '/h/.claude-pipeline/runs/run-ab12CD/vars.sh' && git status", home), '/h/.claude-pipeline/runs/run-ab12CD');
  assert.equal(runDirFromCommand('. /h/.claude-pipeline/runs/run-ab12CD/vars.sh && ls', home), '/h/.claude-pipeline/runs/run-ab12CD');
  assert.equal(runDirFromCommand(". '/elsewhere/runs/run-ab12CD/vars.sh'", home), null);
  assert.equal(runDirFromCommand(". '/h/.claude-pipeline/runs/run-ab12CD/../../x/runs/run-zz/vars.sh'", home), null);
  assert.equal(runDirFromCommand('git status', home), null);
});

test('recordSession appends each session once and needs both fields', () => {
  const runDir = tempDir('run-');
  assert.equal(recordSession(runDir, { sessionId: 's1', transcriptPath: '/t/s1.jsonl', now: new Date('2026-10-20T10:00:00Z') }), true);
  assert.equal(recordSession(runDir, { sessionId: 's1', transcriptPath: '/t/s1.jsonl' }), false);
  assert.equal(recordSession(runDir, { sessionId: 's2', transcriptPath: '/t/s2.jsonl', now: new Date('2026-10-20T11:00:00Z') }), true);
  assert.equal(recordSession(runDir, { sessionId: '', transcriptPath: '/t/x.jsonl' }), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(runDir, 'session.json'), 'utf8')).sessions, [
    { sessionId: 's1', transcriptPath: '/t/s1.jsonl', firstSeen: '2026-10-20T10:00:00.000Z' },
    { sessionId: 's2', transcriptPath: '/t/s2.jsonl', firstSeen: '2026-10-20T11:00:00.000Z' },
  ]);
  assert.equal(recordSession(path.join(runDir, 'gone'), { sessionId: 's3', transcriptPath: '/t/s3.jsonl' }), false);
});

test('markers are JSON with the run folder; an old plain-date marker reads as empty', () => {
  const dir = tempDir('marker-');
  const file = path.join(dir, 's1');
  writeFileSync(file, markerContent('/h/runs/run-1', new Date('2026-10-20T10:00:00Z')));
  assert.deepEqual(readMarker(file), { at: '2026-10-20T10:00:00.000Z', runDir: '/h/runs/run-1' });
  writeFileSync(file, '2026-10-20T10:00:00.000Z\n');
  assert.deepEqual(readMarker(file), {});
  assert.deepEqual(readMarker(path.join(dir, 'missing')), {});
});
