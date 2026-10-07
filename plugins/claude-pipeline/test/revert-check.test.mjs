import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { changedTestFiles, revertCheck } from '../skills/ship/scripts/lib/revert-check.mjs';
import { git, makeRepoWithOrigin, writeFiles } from './helpers/git.mjs';
import { runCli } from './helpers/cli.mjs';

function repoWithChange({ lib, test: testScript, extra = {} }) {
  const { root } = makeRepoWithOrigin({ 'lib.txt': 'old\n', 'test/t.sh': 'grep -q old lib.txt\n' });
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', '-b', 'claude/1-x']);
  writeFiles(root, { 'lib.txt': lib, 'test/t.sh': testScript, ...extra });
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'change']);
  return { root, base };
}

test('changedTestFiles lists test files touched by the branch, not docs/pipeline', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'grep -q new lib.txt\n', extra: { 'docs/pipeline/1/evidence.md': 'x', 'src/x.ts': 'y' } });
  assert.deepEqual(changedTestFiles(root, base), ['test/t.sh']);
});

test('revertCheck reports failed:true when the new tests fail against the base source', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'grep -q new lib.txt\n' });
  const r = revertCheck(root, base, { command: 'sh test/t.sh' });
  assert.equal(r.skipped, false);
  assert.deepEqual(r.testFiles, ['test/t.sh']);
  assert.equal(r.failed, true);
  assert.notEqual(r.exitCode, 0);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1, 'the temporary worktree is removed');
  assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'the branch is untouched');
});

test('revertCheck reports failed:false when the tests pass without the change', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'true\n' });
  const r = revertCheck(root, base, { command: 'sh test/t.sh' });
  assert.equal(r.failed, false);
  assert.equal(r.exitCode, 0);
});

test('revertCheck skips when no test file changed (Q14)', () => {
  const { root } = makeRepoWithOrigin({ 'lib.txt': 'old\n' });
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', '-b', 'claude/2-x']);
  writeFiles(root, { 'lib.txt': 'new\n' });
  git(root, ['commit', '-am', 'no tests']);
  assert.deepEqual(revertCheck(root, base, { command: 'true' }), { skipped: true, reason: 'no test files changed between the base and HEAD' });
});

test('revertCheck treats a timeout as an error, not as a failing test, and removes its worktree', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'sleep 5\n' });
  const r = revertCheck(root, base, { command: 'sh test/t.sh', timeoutMs: 300 });
  assert.equal(r.failed, false);
  assert.equal(r.exitCode, null);
  assert.match(r.error, /timed out/);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('revertCheck reports error: null when the command ran to completion', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'grep -q new lib.txt\n' });
  assert.equal(revertCheck(root, base, { command: 'sh test/t.sh' }).error, null);
});

test('revertCheck preserves the executable bit of changed test files', () => {
  const { root } = makeRepoWithOrigin({ 'lib.txt': 'old\n' });
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', '-b', 'claude/3-x']);
  writeFiles(root, { 'lib.txt': 'new\n', 'test/run.sh': '#!/bin/sh\ngrep -q new lib.txt\n' });
  chmodSync(path.join(root, 'test/run.sh'), 0o755);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'change']);
  assert.match(git(root, ['ls-files', '-s', 'test/run.sh']), /^100755 /);
  const r = revertCheck(root, base, { command: './test/run.sh' });
  assert.equal(r.exitCode, 1);
  assert.equal(r.failed, true);
});

test('revertCheck preserves the bytes of binary test files', () => {
  const { root } = makeRepoWithOrigin({ 'lib.txt': 'old\n', 'test/fixture.bin': Buffer.from([0x00]) });
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', '-b', 'claude/4-x']);
  writeFileSync(path.join(root, 'test/fixture.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'binary']);
  const r = revertCheck(root, base, { command: 'od -An -tx1 test/fixture.bin | tr -d " \\n" | grep -q fffe0080' });
  assert.equal(r.exitCode, 0);
  assert.equal(r.failed, false);
});

test('revertCheck reports spawn errors such as ENOBUFS as errors, not failures', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'true\n' });
  const r = revertCheck(root, base, { command: 'head -c 1024 /dev/zero | tr "\\0" x', maxBuffer: 16 });
  assert.equal(r.failed, false);
  assert.equal(r.exitCode, null);
  assert.match(r.error, /ENOBUFS/);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('CLI revert-check prints the result', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'grep -q new lib.txt\n' });
  const r = runCli(['revert-check', '--base', base, '--command', 'sh test/t.sh', '--cwd', root]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().failed, true);
  assert.equal(runCli(['revert-check', '--base', base, '--cwd', root]).code, 2);
});
