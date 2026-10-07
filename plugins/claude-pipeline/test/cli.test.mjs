import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers/cli.mjs';

test('version prints the plugin version as JSON', () => {
  const r = runCli(['version']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { version: '0.1.0' });
});

test('an unknown command exits 2 with a JSON error on stderr', () => {
  const r = runCli(['nope']);
  assert.equal(r.code, 2);
  const err = JSON.parse(r.stderr);
  assert.match(err.error, /unknown command "nope"/);
  assert.match(err.error, /expected one of:/);
});

test('constructor is an unknown command, not a prototype property', () => {
  const r = runCli(['constructor']);
  assert.equal(r.code, 2);
  const err = JSON.parse(r.stderr);
  assert.match(err.error, /unknown command "constructor"/);
});

test('an unexpected positional argument is a usage error', () => {
  const r = runCli(['version', 'extra']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /"error"/);
});
