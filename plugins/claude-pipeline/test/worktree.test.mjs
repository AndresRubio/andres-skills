import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createWorktree, isolateInPlace, removeWorktreeIfEmpty } from '../skills/ship/scripts/lib/worktree.mjs';
import { git, makeRepoWithOrigin, tempDir, writeFiles } from './helpers/git.mjs';
import { runCli } from './helpers/cli.mjs';

const setup = () => {
  const repo = makeRepoWithOrigin();
  const wt = path.join(tempDir('cph-'), 'worktrees', 'work', '5');
  return { ...repo, wt, args: { repoRoot: repo.root, path: wt, branch: 'claude/5-x', base: 'origin/main' } };
};

test('creates a new branch from the base in a worktree outside the repo', () => {
  const { root, wt, args } = setup();
  const r = createWorktree(args);
  assert.deepEqual(r, { path: wt, branch: 'claude/5-x', created: true, resumed: false, inPlace: false });
  assert.equal(git(wt, ['branch', '--show-current']).trim(), 'claude/5-x');
  assert.ok(!wt.startsWith(root));
});

test('a second call reuses the existing worktree', () => {
  const { args } = setup();
  createWorktree(args);
  assert.deepEqual(createWorktree(args), { path: args.path, branch: 'claude/5-x', created: false, resumed: true, inPlace: false });
});

test('an existing path on another branch is an error', () => {
  const { args } = setup();
  createWorktree(args);
  assert.throws(() => createWorktree({ ...args, branch: 'claude/6-y' }), /expected "claude\/6-y"/);
});

test('resumes a local branch whose worktree was removed', () => {
  const { root, args } = setup();
  createWorktree(args);
  git(root, ['worktree', 'remove', args.path]);
  const r = createWorktree(args);
  assert.equal(r.resumed, true);
});

test('recovers when the worktree folder was deleted by hand, leaving a stale registration', () => {
  const { args } = setup();
  createWorktree(args);
  rmSync(args.path, { recursive: true, force: true });
  const r = createWorktree(args);
  assert.equal(r.resumed, true);
  assert.equal(existsSync(args.path), true);
});

test('resumes a branch that exists only on the remote', () => {
  const { remote, base, args } = setup();
  const other = path.join(base, 'other');
  git(base, ['clone', remote, other]);
  git(other, ['checkout', '-b', 'claude/5-x']);
  writeFiles(other, { 'done.txt': 'x\n' });
  git(other, ['add', '-A']);
  git(other, ['commit', '-m', 'earlier run']);
  git(other, ['push', '-u', 'origin', 'claude/5-x']);
  git(args.repoRoot, ['fetch', 'origin']);
  const r = createWorktree(args);
  assert.equal(r.resumed, true);
  assert.ok(existsSync(path.join(args.path, 'done.txt')));
});

test('removeWorktreeIfEmpty removes a worktree holding only pipeline notes', () => {
  const { root, args } = setup();
  createWorktree(args);
  writeFiles(args.path, { 'docs/pipeline/5/grade.md': '# Grade\n' });
  assert.deepEqual(removeWorktreeIfEmpty(args), { removed: true });
  assert.equal(existsSync(args.path), false);
  assert.equal(git(root, ['branch', '--list', 'claude/5-x']).trim(), '');
});

test('removeWorktreeIfEmpty keeps commits and other uncommitted work', () => {
  const { args } = setup();
  createWorktree(args);
  writeFiles(args.path, { 'src/a.ts': 'x\n' });
  assert.equal(removeWorktreeIfEmpty(args).removed, false);
  git(args.path, ['add', '-A']);
  git(args.path, ['commit', '-m', 'work']);
  assert.match(removeWorktreeIfEmpty(args).reason, /1 commit/);
});

test('removeWorktreeIfEmpty refuses to delete a branch the worktree is not on', () => {
  const { root, args } = setup();
  createWorktree(args);
  const other = path.join(tempDir('cph-'), 'worktrees', 'work', '6');
  createWorktree({ repoRoot: root, path: other, branch: 'claude/6-y', base: 'origin/main' });
  writeFiles(other, { 'x.txt': 'x\n' });
  git(other, ['add', '-A']);
  git(other, ['commit', '-m', 'work on 6']);
  git(root, ['worktree', 'remove', other]);
  const r = removeWorktreeIfEmpty({ ...args, branch: 'claude/6-y' });
  assert.equal(r.removed, false);
  assert.match(r.reason, /claude\/5-x/);
  assert.notEqual(git(root, ['branch', '--list', 'claude/6-y']).trim(), '');
});

test('removeWorktreeIfEmpty refuses when the worktree HEAD is detached', () => {
  const { args } = setup();
  createWorktree(args);
  writeFiles(args.path, { 'a.txt': 'x\n' });
  git(args.path, ['add', '-A']);
  git(args.path, ['commit', '-m', 'work']);
  git(args.path, ['switch', '--detach', 'origin/main']);
  const r = removeWorktreeIfEmpty(args);
  assert.equal(r.removed, false);
  assert.match(r.reason, /detached HEAD/);
  assert.doesNotThrow(() => git(args.repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/heads/claude/5-x']));
});

test('isolateInPlace switches the checkout itself', () => {
  const { root } = setup();
  const r = isolateInPlace({ repoRoot: root, branch: 'claude/7-z', base: 'origin/main' });
  assert.deepEqual(r, { path: root, branch: 'claude/7-z', created: true, resumed: false, inPlace: true });
  assert.equal(removeWorktreeIfEmpty({ repoRoot: root, path: root, branch: 'claude/7-z', base: 'origin/main' }).reason, 'in-place checkout');
});

test('CLI worktree uses the pipeline home', () => {
  const { root } = makeRepoWithOrigin();
  const home = tempDir('cph-');
  const r = runCli(['worktree', '--repo-root', root, '--key', '5', '--branch', 'claude/5-x', '--base', 'origin/main'], { env: { CLAUDE_PIPELINE_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().path, path.join(home, 'worktrees', 'work', '5'));
});
