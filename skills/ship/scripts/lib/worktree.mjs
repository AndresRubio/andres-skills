import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

function hasRef(cwd, ref) {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

export function createWorktree({ repoRoot, path: wt, branch, base }) {
  if (existsSync(wt)) {
    const current = git(wt, ['branch', '--show-current']).trim();
    if (current !== branch) throw new Error(`${wt} exists on branch "${current}", expected "${branch}"`);
    return { path: wt, branch, created: false, resumed: true, inPlace: false };
  }
  mkdirSync(path.dirname(wt), { recursive: true });
  if (hasRef(repoRoot, `refs/heads/${branch}`)) {
    git(repoRoot, ['worktree', 'add', wt, branch]);
    return { path: wt, branch, created: true, resumed: true, inPlace: false };
  }
  if (hasRef(repoRoot, `refs/remotes/origin/${branch}`)) {
    git(repoRoot, ['worktree', 'add', '--track', '-b', branch, wt, `origin/${branch}`]);
    return { path: wt, branch, created: true, resumed: true, inPlace: false };
  }
  git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, wt, base]);
  return { path: wt, branch, created: true, resumed: false, inPlace: false };
}

export function isolateInPlace({ repoRoot, branch, base }) {
  if (hasRef(repoRoot, `refs/heads/${branch}`)) {
    git(repoRoot, ['switch', branch]);
    return { path: repoRoot, branch, created: false, resumed: true, inPlace: true };
  }
  if (hasRef(repoRoot, `refs/remotes/origin/${branch}`)) {
    git(repoRoot, ['switch', '--track', '-c', branch, `origin/${branch}`]);
    return { path: repoRoot, branch, created: true, resumed: true, inPlace: true };
  }
  git(repoRoot, ['switch', '--no-track', '-c', branch, base]);
  return { path: repoRoot, branch, created: true, resumed: false, inPlace: true };
}

export function removeWorktreeIfEmpty({ repoRoot, path: wt, branch, base }) {
  if (path.resolve(wt) === path.resolve(repoRoot)) return { removed: false, reason: 'in-place checkout' };
  const ahead = Number(git(wt, ['rev-list', '--count', `${base}..HEAD`]).trim());
  if (ahead > 0) return { removed: false, reason: `${ahead} commit(s) on ${branch}` };
  const dirty = git(wt, ['status', '--porcelain', '--', '.', ':(exclude)docs/pipeline']).trim();
  if (dirty) return { removed: false, reason: 'uncommitted changes outside docs/pipeline' };
  git(repoRoot, ['worktree', 'remove', '--force', wt]);
  git(repoRoot, ['branch', '-D', branch]);
  return { removed: true };
}
