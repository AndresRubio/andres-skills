// Output trim (amendment B). hooks/trim.mjs is the I/O wrapper.
import { lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const TRIM_BYTES = 4096;
export const TAIL_LINES = 40;
export const MATCH = /error|fail|warn|exception/i;
export const MAX_MATCHED = 200;
export const MAX_LINE = 1000;

const clip = (l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)} [line cut at ${MAX_LINE} characters]` : l);
// Lines of one stream. The separator the hook writes into the log is never part of this list, so a
// real stdout line that reads "--- stderr ---" stays.
const linesOf = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

export function logContent({ stdout = '', stderr = '' }) {
  if (!stderr) return stdout;
  return `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}--- stderr ---\n${stderr}`;
}

export function trimOutput({ stdout = '', stderr = '' }, { logPath }) {
  const bytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  if (bytes <= TRIM_BYTES) return null;
  const lines = [...linesOf(stdout), ...linesOf(stderr)];
  const tail = lines.slice(-TAIL_LINES);
  const matched = [];
  let more = 0;
  for (let i = 0, end = Math.max(0, lines.length - TAIL_LINES); i < end; i += 1) {
    const l = lines[i];
    if (l === '' || !MATCH.test(l)) continue;
    if (matched.length < MAX_MATCHED) matched.push(l); else more += 1;
  }
  const head = `[issue-pipeline] ${bytes} bytes of output (${lines.length} lines) saved to ${logPath}. Shown: the ${more ? 'first ' : ''}${matched.length} earlier lines matching error|fail|warn|exception, then the last ${tail.length} lines.`;
  return {
    stdout: [head, ...matched.map(clip), ...(more ? [`+${more} more matching lines in the log`] : []), ...(matched.length ? ['...'] : []), ...tail.map(clip)].join('\n'),
    stderr: '',
  };
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
    return lstatSync(resolved).isDirectory(); // lstat: a symlink to a folder is not a run folder
  } catch {
    return false;
  }
}

// The logs folder must be a real folder inside the run folder, never a link to somewhere else.
function ensureLogsDir(logsDir) {
  const real = () => lstatSync(logsDir).isDirectory();
  try {
    if (!real()) throw new Error('logs is not a folder');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    mkdirSync(logsDir, { recursive: true });
    if (!real()) throw new Error('logs is not a folder');
  }
}

// Log numbers count up from the highest one present. Past 2^53 an increment no longer changes the
// number, so the loop would never end: throw instead and let the hook pass the output through.
export function nextLogPath(logsDir) {
  ensureLogsDir(logsDir);
  let n = readdirSync(logsDir).map((f) => f.match(/^(\d+)\.log$/)?.[1]).filter(Boolean).map(Number).reduce((a, b) => Math.max(a, b), 0);
  for (;;) {
    if (!Number.isSafeInteger(n + 1)) throw new Error('log numbers exhausted');
    n += 1;
    const file = path.join(logsDir, `${n}.log`);
    try {
      return { file, fd: openSync(file, 'wx') };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}
