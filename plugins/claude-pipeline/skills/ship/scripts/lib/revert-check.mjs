import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
export function revertCheck(cwd, base, { command, timeoutMs = 600_000 } = {}) {
  if (typeof command !== 'string' || command === '') throw new Error('a test command is required');
  const testFiles = changedTestFiles(cwd, base);
  if (testFiles.length === 0) return { skipped: true, reason: 'no test files changed between the base and HEAD' };
  const wt = mkdtempSync(path.join(tmpdir(), 'cp-revert-'));
  rmSync(wt, { recursive: true, force: true });
  git(cwd, ['worktree', 'add', '--detach', wt, base]);
  try {
    for (const file of testFiles) {
      const content = git(cwd, ['show', `HEAD:${file}`]);
      mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
      writeFileSync(path.join(wt, file), content);
    }
    const r = spawnSync('sh', ['-c', command], { cwd: wt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    const timedOut = r.error?.code === 'ETIMEDOUT';
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}${timedOut ? `\n(timed out after ${timeoutMs} ms)` : ''}`;
    const exitCode = timedOut ? null : r.status;
    return { skipped: false, testFiles, exitCode, failed: exitCode !== 0, tail: output.trim().split('\n').slice(-20).join('\n') };
  } finally {
    try { git(cwd, ['worktree', 'remove', '--force', wt]); } catch { rmSync(wt, { recursive: true, force: true }); git(cwd, ['worktree', 'prune']); }
  }
}
