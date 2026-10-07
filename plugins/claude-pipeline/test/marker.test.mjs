import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMarker, parseMarker, defaultRun, MARKER_KINDS } from '../skills/ship/scripts/lib/marker.mjs';
import { runCli } from './helpers/cli.mjs';

const NOW = new Date('2026-09-25T10:00:00.123Z');

test('formatMarker writes the exact marker line without milliseconds', () => {
  assert.equal(formatMarker('lock', { now: NOW, run: 'local' }), '**[claude-pipeline]** lock · 2026-09-25T10:00:00Z · local');
});

test('formatMarker rejects unknown kinds', () => {
  assert.throws(() => formatMarker('hello', { now: NOW, run: 'local' }), /unknown marker kind/);
});

test('parseMarker reads the first line only', () => {
  const body = '**[claude-pipeline]** grade · 2026-09-25T10:00:00Z · https://x/runs/1\n\n**Verdict:** `ready`';
  assert.deepEqual(parseMarker(body), { kind: 'grade', at: '2026-09-25T10:00:00Z', run: 'https://x/runs/1' });
  assert.equal(parseMarker('hello\n**[claude-pipeline]** lock · 2026-09-25T10:00:00Z · local'), null);
  assert.equal(parseMarker('**[claude-pipeline]** bogus · 2026-09-25T10:00:00Z · local'), null);
  assert.equal(parseMarker(undefined), null);
});

test('every kind round-trips', () => {
  for (const kind of MARKER_KINDS) {
    assert.equal(parseMarker(formatMarker(kind, { now: NOW, run: 'local' })).kind, kind);
  }
});

test('deferred is the last kind and round-trips', () => {
  assert.equal(MARKER_KINDS.at(-1), 'deferred');
  const line = formatMarker('deferred', { now: NOW, run: 'local' });
  assert.equal(line, '**[claude-pipeline]** deferred · 2026-09-25T10:00:00Z · local');
  assert.deepEqual(parseMarker(`${line}\n\nWaiting for: 7`), { kind: 'deferred', at: '2026-09-25T10:00:00Z', run: 'local' });
});

test('defaultRun uses the Actions run URL when present', () => {
  assert.equal(defaultRun({}), 'local');
  assert.equal(
    defaultRun({ GITHUB_RUN_ID: '42', GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: 'https://github.com' }),
    'https://github.com/o/r/actions/runs/42',
  );
});

test('CLI marker prints the line; parse-marker reads stdin', () => {
  const r = runCli(['marker', 'report', '--now', '2026-09-25T10:00:00Z'], { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '**[claude-pipeline]** report · 2026-09-25T10:00:00Z · local\n');
  const p = runCli(['parse-marker'], { input: r.stdout });
  assert.deepEqual(p.json(), { kind: 'report', at: '2026-09-25T10:00:00Z', run: 'local' });
});
