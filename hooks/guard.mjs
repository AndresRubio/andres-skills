#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCommand, isActivating } from '../skills/ship/scripts/lib/guard.mjs';

// The run guard, as a Claude Code PreToolUse hook on Bash. It reads the hook input on stdin
// and exits 2 (with the reason on stderr) to block the command; exit 0 lets it through.
// The logic is in skills/ship/scripts/lib/guard.mjs. This file only does the I/O.

const MARKER_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

// <home>/guard/<session_id>, with the session id cut down to safe characters. Null when the
// hook input has no usable session id.
function markerPath(home, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  return path.join(home, 'guard', sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
}

// Marks this session as a pipeline run, then deletes markers older than 14 days. Best effort:
// the guard still checks the current command when this fails.
function activate(marker) {
  if (!marker) return;
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`);
    const dir = path.dirname(marker);
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (Date.now() - statSync(file).mtimeMs > MARKER_MAX_AGE_MS) unlinkSync(file);
      } catch {
        // gone already, or not ours to delete
      }
    }
  } catch {
    // best effort
  }
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const command = input?.tool_input?.command;
  if (input?.tool_name !== 'Bash' || typeof command !== 'string') return;

  const mode = process.env.CLAUDE_PIPELINE_GUARD;
  if (mode === '0') return;

  const home = process.env.CLAUDE_PIPELINE_HOME || path.join(os.homedir(), '.claude-pipeline');
  const marker = markerPath(home, input.session_id);
  let active = mode === '1' || (marker !== null && existsSync(marker));
  try {
    if (isActivating(command)) {
      activate(marker);
      active = true;
    }
    if (!active) return;
    const verdict = checkCommand(command, { home });
    if (verdict.allow) return;
    block([
      `claude-pipeline guard: ${verdict.reason}.`,
      'The pipeline pushes only with `git push origin "$BRANCH"` or `git push -u origin "$BRANCH"`, after sourcing vars.sh, with nothing but `cd`, `git add`, `git commit` and `git status` in the same command, and it never merges. Don\'t look for another way to do this: follow the stop procedure. If the command only mentions push or merge in text, put that text in a file with the file-writing tool.',
    ].join('\n'));
  } catch (err) {
    if (active && /\b(push|merge)\b/.test(command)) {
      block(`claude-pipeline guard: could not check this command (${err.message})`);
    }
  }
}

await main();
