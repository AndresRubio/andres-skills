// What the run guard hook records for measurement (spec §7.5, amendment I): the session's transcript
// path in $RUN_DIR/session.json, and the run folder in the guard marker for the trim hook.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Linear: find the tail first, then walk back to the start of its token (a nested quantifier
// before the tail backtracks quadratically on a long run of slashes).
const VARS = /\/runs\/run-[A-Za-z0-9]+\/vars\.sh/;
const TOKEN_BREAK = /[\s'"]/;

export function runDirFromCommand(command, home) {
  const text = String(command ?? '');
  const m = VARS.exec(text);
  if (!m) return null;
  let start = m.index;
  while (start > 0 && !TOKEN_BREAK.test(text[start - 1])) start -= 1;
  const first = text.indexOf('/', start);
  const dir = path.resolve(text.slice(first, m.index + m[0].length - '/vars.sh'.length));
  const runs = path.join(path.resolve(home), 'runs') + path.sep;
  return dir.startsWith(runs) && !dir.slice(runs.length).includes(path.sep) ? dir : null;
}

export function recordSession(runDir, { sessionId, transcriptPath, now = new Date() }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof transcriptPath !== 'string' || !transcriptPath) return false;
  if (!existsSync(runDir)) return false;
  const file = path.join(runDir, 'session.json');
  let data = { sessions: [] };
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first record */ }
  if (!Array.isArray(data.sessions)) data = { sessions: [] };
  if (data.sessions.some((s) => s.sessionId === sessionId)) return false;
  data.sessions.push({ sessionId, transcriptPath, firstSeen: new Date(now).toISOString() });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

export function readMarker(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function markerContent(runDir, now = new Date()) {
  return `${JSON.stringify({ at: new Date(now).toISOString(), runDir: runDir ?? null })}\n`;
}
