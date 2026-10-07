import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('revertCheck removes its worktree even when the command times out', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'sleep 5\n' });
  const r = revertCheck(root, base, { command: 'sh test/t.sh', timeoutMs: 300 });
  assert.equal(r.failed, true);
  assert.match(r.tail, /timed out/);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('CLI revert-check prints the result', () => {
  const { root, base } = repoWithChange({ lib: 'new\n', test: 'grep -q new lib.txt\n' });
  const r = runCli(['revert-check', '--base', base, '--command', 'sh test/t.sh', '--cwd', root]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().failed, true);
  assert.equal(runCli(['revert-check', '--base', base, '--cwd', root]).code, 2);
});
