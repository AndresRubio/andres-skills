import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource } from '../skills/ship/scripts/lib/source.mjs';
import { runCli } from './helpers/cli.mjs';

test('#12 and 12 are GitHub issues with key "12"', () => {
  assert.deepEqual(parseSource('#12'), { kind: 'github', number: 12, key: '12' });
  assert.deepEqual(parseSource(' 12 '), { kind: 'github', number: 12, key: '12' });
});

test('GitHub issue and PR URLs', () => {
  assert.deepEqual(parseSource('https://github.com/o/r/issues/7'), { kind: 'github', owner: 'o', repo: 'r', number: 7, key: '7' });
  assert.deepEqual(parseSource('https://github.com/o/r/issues/7#issuecomment-1'), { kind: 'github', owner: 'o', repo: 'r', number: 7, key: '7' });
  assert.deepEqual(parseSource('https://github.com/o/r/pull/9'), { kind: 'github-pr', owner: 'o', repo: 'r', number: 9 });
});

test('GitHub URLs with extra path segments after the number still resolve to that number', () => {
  assert.deepEqual(parseSource('https://github.com/o/r/pull/9/files'), { kind: 'github-pr', owner: 'o', repo: 'r', number: 9 });
  assert.deepEqual(parseSource('https://github.com/o/r/pull/9/commits'), { kind: 'github-pr', owner: 'o', repo: 'r', number: 9 });
  assert.deepEqual(parseSource('https://github.com/o/r/issues/12/'), { kind: 'github', owner: 'o', repo: 'r', number: 12, key: '12' });
});

test('Linear IDs and URLs get a lowercased key', () => {
  assert.deepEqual(parseSource('OLD-43'), { kind: 'linear', id: 'OLD-43', key: 'old-43' });
  assert.deepEqual(parseSource('https://linear.app/old-world/issue/OLD-43/some-title'), { kind: 'linear', id: 'OLD-43', key: 'old-43' });
});

test('anything else is free text', () => {
  assert.deepEqual(parseSource('Fix the #12 bug'), { kind: 'text', text: 'Fix the #12 bug' });
  assert.deepEqual(parseSource('old-43'), { kind: 'text', text: 'old-43' });
});

test('an empty source throws', () => {
  assert.throws(() => parseSource('  '), /source is empty/);
});

test('CLI source prints the parsed source', () => {
  const r = runCli(['source', 'Add dark mode']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { kind: 'text', text: 'Add dark mode' });
});
