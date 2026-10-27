#!/usr/bin/env node
import { closeSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMarker } from '../skills/ship/scripts/lib/session.mjs';
import { TRIM_BYTES, isRunDir, logContent, nextLogPath, trimOutput } from '../skills/ship/scripts/lib/trim.mjs';

// Output trim (amendment B): a PostToolUse hook on Bash, switched on by the run guard's marker.
// Opt-in with CLAUDE_PIPELINE_TRIM=1 until it has been observed on real runs (Phase 2b Task 18).
// It never fails a command: on any problem the output passes through unchanged.
async function main() {
  if (process.env.CLAUDE_PIPELINE_TRIM !== '1' || process.env.CLAUDE_PIPELINE_GUARD === '0') return;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const out = input?.tool_response;
  if (input?.tool_name !== 'Bash' || !out || typeof out !== 'object' || out.isImage) return;
  if (typeof input.session_id !== 'string' || !input.session_id) return;
  const stdout = typeof out.stdout === 'string' ? out.stdout : '';
  const stderr = typeof out.stderr === 'string' ? out.stderr : '';
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= TRIM_BYTES) return;
  const home = process.env.CLAUDE_PIPELINE_HOME || path.join(os.homedir(), '.claude-pipeline');
  const { runDir } = readMarker(path.join(home, 'guard', input.session_id.replace(/[^A-Za-z0-9_-]/g, '_')));
  // The marker is a file on disk: write a log only into an existing run folder under <home>/runs/.
  if (!isRunDir(runDir, home)) return;
  const { file, fd } = nextLogPath(path.join(runDir, 'logs'));
  try { writeFileSync(fd, logContent({ stdout, stderr })); } finally { closeSync(fd); }
  const trimmed = trimOutput({ stdout, stderr }, { logPath: file });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: trimmed.stdout, stderr: trimmed.stderr, interrupted: Boolean(out.interrupted), isImage: false } },
  }));
}

try { await main(); } catch { /* pass the output through */ }
