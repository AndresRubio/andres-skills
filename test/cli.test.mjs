import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers/cli.mjs';

test('version prints the plugin version as JSON', () => {
  const r = runCli(['version']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { version: '0.1.0' });
});

test('an unknown command exits 2 with usage on stderr', () => {
  const r = runCli(['nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: pipeline </);
});

test('an unexpected positional argument is a usage error', () => {
  const r = runCli(['version', 'extra']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /"error"/);
});
