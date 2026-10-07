import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from './git.mjs';
import { isTestFile } from './diff-risk.mjs';

export function changedTestFiles(cwd, base) {
  const out = git(cwd, ['diff', '--name-status', `${base}...HEAD`, '--', '.', ':(exclude)docs/pipeline']);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [status, a, b] = line.split('\t');
    if (status[0] === 'D') continue;
    const file = b ?? a;
    if (isTestFile(file)) files.push(file);
  }
  return files.sort();
}

// The tests come from HEAD; everything else from base. At least one test should fail.
export function revertCheck(cwd, base, { command, timeoutMs = 600_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  if (typeof command !== 'string' || command === '') throw new Error('a test command is required');
  const testFiles = changedTestFiles(cwd, base);
  if (testFiles.length === 0) return { skipped: true, reason: 'no test files changed between the base and HEAD' };
  const headSha = git(cwd, ['rev-parse', 'HEAD']).trim();
  const wt = mkdtempSync(path.join(tmpdir(), 'cp-revert-'));
  rmSync(wt, { recursive: true, force: true });
  git(cwd, ['worktree', 'add', '--detach', wt, base]);
  try {
    // Check the blobs out by SHA (same object database): bytes and file modes survive.
    git(wt, ['checkout', headSha, '--', ...testFiles]);
    const r = spawnSync('sh', ['-c', command], { cwd: wt, encoding: 'utf8', timeout: timeoutMs, maxBuffer });
    let error = null;
    if (r.error?.code === 'ETIMEDOUT') error = `timed out after ${timeoutMs} ms`;
    else if (r.error) error = `${r.error.code ?? 'error'}: ${r.error.message}`;
    else if (r.signal) error = `killed by ${r.signal}`;
    const exitCode = error === null ? r.status : null;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return { skipped: false, testFiles, exitCode, failed: error === null && exitCode !== 0, error, tail: output.trim().split('\n').slice(-20).join('\n') };
  } finally {
    try { git(cwd, ['worktree', 'remove', '--force', wt]); } catch { rmSync(wt, { recursive: true, force: true }); git(cwd, ['worktree', 'prune']); }
  }
}
