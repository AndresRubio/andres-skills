export const MARKER_KINDS = Object.freeze(['lock', 'grade', 'questions', 'assumptions', 'split', 'report', 'blocked', 'reminder', 'stale-lock', 'deferred']);

const PREFIX = '**[claude-pipeline]**';
const LINE = /^\*\*\[claude-pipeline\]\*\* ([a-z-]+) · (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) · (\S+)\s*$/;

export function defaultRun(env = process.env) {
  if (env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY) {
    return `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return 'local';
}

export function formatMarker(kind, { now = new Date(), run = defaultRun() } = {}) {
  if (!MARKER_KINDS.includes(kind)) throw new Error(`unknown marker kind: ${kind}`);
  const at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${PREFIX} ${kind} · ${at} · ${run}`;
}

export function parseMarker(body) {
  const first = String(body ?? '').split(/\r?\n/, 1)[0];
  const m = first.match(LINE);
  if (!m || !MARKER_KINDS.includes(m[1])) return null;
  return { kind: m[1], at: m[2], run: m[3] };
}
