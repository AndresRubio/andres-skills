import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimOutput, logContent, nextLogPath } from '../skills/ship/scripts/lib/trim.mjs';
import { markerContent } from '../skills/ship/scripts/lib/session.mjs';
import { tempDir } from './helpers/git.mjs';

const HOOK = fileURLToPath(new URL('../hooks/trim.mjs', import.meta.url));
const many = (n, f = (i) => `ok ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

test('trimOutput leaves 4 KB alone and trims more to the matching lines and the last 40', () => {
  assert.equal(trimOutput({ stdout: 'x'.repeat(4096) }, { logPath: '/l/1.log' }), null);
  const stdout = many(300, (i) => (i === 7 ? 'Error: boom at line 7' : i === 100 ? 'WARN deprecated' : `ok ${i} ${'.'.repeat(20)}`));
  const r = trimOutput({ stdout, stderr: 'npm ERR! failed\n' }, { logPath: '/l/1.log' });
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^\[claude-pipeline\] \d+ bytes of output \(301 lines\) saved to \/l\/1\.log\. Shown: the 2 earlier lines matching error\|fail\|warn\|exception, then the last 40 lines\.$/);
  assert.deepEqual(lines.slice(1, 4), ['Error: boom at line 7', 'WARN deprecated', '...']);
  assert.equal(lines.length, 1 + 2 + 1 + 40);
  assert.equal(lines.at(-1), 'npm ERR! failed');
  assert.equal(r.stderr, '');
});

test('logContent keeps both streams; nextLogPath never reuses a number', () => {
  assert.equal(logContent({ stdout: 'a', stderr: 'b' }), 'a\n--- stderr ---\nb');
  assert.equal(logContent({ stdout: 'a\n' }), 'a\n');
  const dir = path.join(tempDir('logs-'), 'logs');
  mkdirSync(dir);
  writeFileSync(path.join(dir, '3.log'), '');
  writeFileSync(path.join(dir, '07-verify-tests.log'), '');
  const a = nextLogPath(dir);
  const b = nextLogPath(dir);
  closeSync(a.fd); closeSync(b.fd);
  assert.deepEqual([path.basename(a.file), path.basename(b.file)], ['4.log', '5.log']);
});

function setup({ runDirExists = true, withRunDir = true } = {}) {
  const home = tempDir('trim-home-');
  const runDir = path.join(home, 'runs', 'run-abc123');
  if (runDirExists) mkdirSync(runDir, { recursive: true });
  mkdirSync(path.join(home, 'guard'), { recursive: true });
  writeFileSync(path.join(home, 'guard', 's1'), markerContent(withRunDir ? runDir : null));
  return { home, runDir };
}
function runHook({ home, env = {}, response }) {
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 's1', tool_input: { command: 'npm test' }, tool_response: response });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLAUDE_PIPELINE_HOME: home, CLAUDE_PIPELINE_GUARD: '', ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const big = { stdout: many(1000), stderr: '', interrupted: false, isImage: false }; // about 7 KB

test('hook: with CLAUDE_PIPELINE_TRIM=1 and an active run, big output is logged and replaced', () => {
  const { home, runDir } = setup();
  const r = runHook({ home, env: { CLAUDE_PIPELINE_TRIM: '1' }, response: big });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PostToolUse');
  assert.deepEqual(Object.keys(out.updatedToolOutput).sort(), ['interrupted', 'isImage', 'stderr', 'stdout']);
  assert.match(out.updatedToolOutput.stdout, new RegExp(`saved to ${path.join(runDir, 'logs', '1.log').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(readFileSync(path.join(runDir, 'logs', '1.log'), 'utf8'), big.stdout);
});

test('hook: passes output through when off, small, an image, without a run folder, or with the guard off', () => {
  const on = { CLAUDE_PIPELINE_TRIM: '1' };
  assert.equal(runHook({ home: setup().home, response: big }).stdout, '');
  assert.equal(runHook({ home: setup().home, env: on, response: { ...big, stdout: 'short' } }).stdout, '');
  assert.equal(runHook({ home: setup().home, env: on, response: { ...big, isImage: true } }).stdout, '');
  assert.equal(runHook({ home: setup({ withRunDir: false }).home, env: on, response: big }).stdout, '');
  assert.equal(runHook({ home: setup({ runDirExists: false }).home, env: on, response: big }).stdout, '');
  assert.equal(runHook({ home: setup().home, env: { ...on, CLAUDE_PIPELINE_GUARD: '0' }, response: big }).stdout, '');
  assert.equal(runHook({ home: tempDir('no-marker-'), env: on, response: big }).stdout, '');
});

test('hook: a marker whose runDir is outside <home>/runs/ passes the output through and writes nothing', () => {
  const on = { CLAUDE_PIPELINE_TRIM: '1' };
  const elsewhere = tempDir('trim-elsewhere-');
  const cases = [
    elsewhere, // an existing folder outside the pipeline home
    '', // a relative or empty value
    'runs/run-abc123', // relative
  ];
  for (const runDir of cases) {
    const { home } = setup();
    writeFileSync(path.join(home, 'guard', 's1'), markerContent(runDir));
    const r = runHook({ home, env: on, response: big });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', `runDir ${JSON.stringify(runDir)}`);
  }
  assert.equal(existsSync(path.join(elsewhere, 'logs')), false);

  // Inside runs/ but not a direct child, a traversal out of runs/, and runs/ itself.
  for (const rel of [['runs', 'run-abc123', 'sub'], ['runs', '..', 'outside'], ['runs']]) {
    const { home } = setup();
    const dir = path.join(home, ...rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(home, 'guard', 's1'), markerContent(dir));
    assert.equal(runHook({ home, env: on, response: big }).stdout, '', rel.join('/'));
    assert.equal(existsSync(path.join(dir, 'logs')), false, rel.join('/'));
  }
});

test('hook: bad stdin or a non-object tool_response never fails the command', () => {
  const { home } = setup();
  const env = { ...process.env, CLAUDE_PIPELINE_HOME: home, CLAUDE_PIPELINE_GUARD: '', CLAUDE_PIPELINE_TRIM: '1' };
  for (const input of ['', 'not json', '{}', JSON.stringify({ tool_name: 'Bash', session_id: 's1', tool_response: 'text' })]) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  }
});

test('a 5 MB stdout trims in well under a second, in the library and through the hook', () => {
  const stdout = many(250000, (i) => `line ${i} ${'.'.repeat(10)}${i % 5000 === 0 ? ' error' : ''}`); // about 5 MB
  assert.ok(stdout.length > 4.5 * 1024 * 1024);
  let t = performance.now();
  const r = trimOutput({ stdout, stderr: '' }, { logPath: '/l/1.log' });
  assert.ok(performance.now() - t < 1000, 'trimOutput took too long');
  assert.equal(r.stdout.split('\n').length, 1 + 49 + 1 + 40); // 50 error lines, the last one in the tail
  // One huge line and a wall of empty lines are the other linear-time shapes.
  t = performance.now();
  assert.ok(trimOutput({ stdout: 'x'.repeat(5 * 1024 * 1024), stderr: '' }, { logPath: '/l/1.log' }));
  assert.ok(trimOutput({ stdout: '\n'.repeat(5 * 1024 * 1024), stderr: '' }, { logPath: '/l/1.log' }));
  assert.ok(performance.now() - t < 1000, 'long line or blank lines took too long');

  const { home, runDir } = setup();
  t = performance.now();
  const h = runHook({ home, env: { CLAUDE_PIPELINE_TRIM: '1' }, response: { stdout, stderr: '', interrupted: false, isImage: false } });
  assert.ok(performance.now() - t < 1500, 'hook took too long');
  assert.equal(h.code, 0);
  assert.equal(readFileSync(path.join(runDir, 'logs', '1.log'), 'utf8'), stdout);
  assert.ok(JSON.parse(h.stdout).hookSpecificOutput.updatedToolOutput.stdout.length < 8000);
});

test('hooks.json runs trim.mjs as a PostToolUse hook on Bash next to the guard', () => {
  const cfg = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const post = cfg.hooks.PostToolUse.find((h) => h.matcher === 'Bash');
  assert.ok(post.hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}/hooks/trim.mjs'));
  assert.ok(cfg.hooks.PreToolUse.find((h) => h.matcher === 'Bash').hooks[0].command.includes('guard.mjs'));
  assert.equal(cfg.hooks.PreToolUse.find((h) => h.matcher === 'Bash').hooks[0].timeout, 10);
});
