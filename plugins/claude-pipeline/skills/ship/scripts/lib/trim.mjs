// Output trim (amendment B). hooks/trim.mjs is the I/O wrapper.
import { mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const TRIM_BYTES = 4096;
export const TAIL_LINES = 40;
export const MATCH = /error|fail|warn|exception/i;

export function logContent({ stdout = '', stderr = '' }) {
  if (!stderr) return stdout;
  return `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}--- stderr ---\n${stderr}`;
}

export function trimOutput({ stdout = '', stderr = '' }, { logPath }) {
  const bytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  if (bytes <= TRIM_BYTES) return null;
  const lines = logContent({ stdout, stderr }).replace(/\n$/, '').split('\n').filter((l) => l !== '--- stderr ---');
  const tail = lines.slice(-TAIL_LINES);
  const matched = lines.slice(0, Math.max(0, lines.length - TAIL_LINES)).filter((l) => MATCH.test(l));
  const head = `[claude-pipeline] ${bytes} bytes of output (${lines.length} lines) saved to ${logPath}. Shown: the ${matched.length} earlier lines matching error|fail|warn|exception, then the last ${tail.length} lines.`;
  return { stdout: [head, ...matched, ...(matched.length ? ['...'] : []), ...tail].join('\n'), stderr: '' };
}

// True when dir is an existing folder directly under <home>/runs/. The same containment rule as
// runDirFromCommand in session.mjs: the guard marker is a file on disk, so its runDir is checked
// again before the trim hook writes anything there.
export function isRunDir(dir, home) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  const resolved = path.resolve(dir);
  const runs = path.join(path.resolve(home), 'runs') + path.sep;
  if (!resolved.startsWith(runs) || resolved.slice(runs.length).includes(path.sep)) return false;
  try {
    return statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

export function nextLogPath(logsDir) {
  mkdirSync(logsDir, { recursive: true });
  let n = readdirSync(logsDir).map((f) => f.match(/^(\d+)\.log$/)?.[1]).filter(Boolean).map(Number).reduce((a, b) => Math.max(a, b), 0);
  for (;;) {
    n += 1;
    const file = path.join(logsDir, `${n}.log`);
    try {
      return { file, fd: openSync(file, 'wx') };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}
