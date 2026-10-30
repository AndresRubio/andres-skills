import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('runDirFromCommand is linear on a long run of slashes (the guard must not time out)', () => {
  const started = performance.now();
  assert.equal(runDirFromCommand(`git push origin HEAD:main # ${'/'.repeat(200_000)}`, '/h/.claude-pipeline'), null);
  assert.equal(runDirFromCommand(`${'/'.repeat(200_000)}`, '/h/.claude-pipeline'), null);
  assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms`);
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

test('recordSession writes through a temp file in the run dir and renames it over session.json', () => {
  const runDir = tempDir('run-');
  recordSession(runDir, { sessionId: 's1', transcriptPath: '/t/s1.jsonl' });
  const before = readFileSync(path.join(runDir, 'session.json'), 'utf8');
  linkSync(path.join(runDir, 'session.json'), path.join(runDir, 'old-link'));
  recordSession(runDir, { sessionId: 's2', transcriptPath: '/t/s2.jsonl' });
  // An in-place writeFileSync would rewrite the shared inode and the link would show the new content.
  assert.equal(readFileSync(path.join(runDir, 'old-link'), 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(path.join(runDir, 'session.json'), 'utf8')).sessions.length, 2);
  assert.deepEqual(readdirSync(runDir).filter((f) => f.endsWith('.tmp')), []);
});

test('recordSession skips entries that are not objects and still records the new session', () => {
  for (const bad of [null, 5, 'x', [], [1]]) {
    const runDir = tempDir('run-');
    writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ sessions: [bad, { sessionId: 'old', transcriptPath: '/t/o.jsonl', firstSeen: 'then' }] }));
    assert.equal(recordSession(runDir, { sessionId: 'new', transcriptPath: '/t/n.jsonl' }), true, JSON.stringify(bad));
    assert.deepEqual(JSON.parse(readFileSync(path.join(runDir, 'session.json'), 'utf8')).sessions.map((s) => s.sessionId), ['old', 'new']);
  }
  const runDir = tempDir('run-');
  writeFileSync(path.join(runDir, 'session.json'), 'null');
  assert.equal(recordSession(runDir, { sessionId: 'x', transcriptPath: '/t/x.jsonl' }), true);
});

const HOOK = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
function runHook(home, command, session) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: session, transcript_path: `/t/${session}.jsonl` });
  const env = { ...process.env, CLAUDE_PIPELINE_HOME: home };
  delete env.CLAUDE_PIPELINE_GUARD;
  return spawnSync(process.execPath, [HOOK], { input, env, encoding: 'utf8' });
}

test('hook: a later activating command that names no run folder keeps the folder the marker already carries', () => {
  const home = tempDir('home-');
  const runDir = path.join(home, 'runs', 'run-abc123');
  mkdirSync(runDir, { recursive: true });
  assert.equal(runHook(home, `. '${runDir}/vars.sh' && git status`, 'carry1').status, 0);
  const marker = path.join(home, 'guard', 'carry1');
  assert.equal(readMarker(marker).runDir, runDir);
  // Setup's mktemp template activates the guard but names no vars.sh.
  assert.equal(runHook(home, `mktemp -d "${home}/runs/run-XXXXXX"`, 'carry1').status, 0);
  assert.equal(readMarker(marker).runDir, runDir);
});

test('hook: an old plain-date marker is replaced by a JSON one with no run folder', () => {
  const home = tempDir('home-');
  mkdirSync(path.join(home, 'guard'), { recursive: true });
  const marker = path.join(home, 'guard', 'plain1');
  writeFileSync(marker, '2026-10-20T10:00:00.000Z\n');
  assert.equal(runHook(home, `mktemp -d "${home}/runs/run-XXXXXX"`, 'plain1').status, 0);
  const marked = readMarker(marker);
  assert.equal(marked.runDir, null);
  assert.match(marked.at, /^\d{4}-\d{2}-\d{2}T/);
});
