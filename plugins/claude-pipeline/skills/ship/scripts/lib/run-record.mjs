// run.json (spec §7.5, D19; cost fields from amendment I). Written by the run itself, in the last
// commit before a push, so writing it never re-runs a PR's checks.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonl, sessionFiles, usageFromTranscripts } from './usage.mjs';

const S = Object.freeze({ model: 'session', effort: 'session' });
// The Model policy table in skills/ship/SKILL.md, one row per stage. "session": the orchestrating
// session does the stage itself. Stage 10 posts the report comment, a tracker operation.
export const STAGE_POLICY = Object.freeze({
  0: Object.freeze({ model: 'haiku', effort: 'low' }),
  1: S,
  2: Object.freeze({ model: 'sonnet', effort: 'medium' }),
  3: Object.freeze({ model: 'strongest', effort: 'high' }),
  4: Object.freeze({ model: 'strongest', effort: 'high' }),
  5: Object.freeze({ model: 'strongest', effort: 'high' }),
  6: Object.freeze({ model: 'sonnet', effort: 'medium' }),
  7: Object.freeze({ model: 'sonnet', effort: 'medium' }),
  8: Object.freeze({ model: 'strongest', effort: 'high' }),
  9: S,
  10: Object.freeze({ model: 'haiku', effort: 'low' }),
  fix: Object.freeze({ model: 'sonnet', effort: 'medium' }),
});

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const seconds = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));

export function stageMark(runDir, { stage, model, effort, now = new Date() }) {
  const key = String(stage);
  if (!Object.hasOwn(STAGE_POLICY, key)) throw new Error(`unknown stage ${key}`);
  const entry = { stage: key, at: iso(now), model: model ?? STAGE_POLICY[key].model, effort: effort ?? STAGE_POLICY[key].effort };
  appendFileSync(path.join(runDir, 'stages.jsonl'), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readStages(runDir) {
  const file = path.join(runDir, 'stages.jsonl');
  return existsSync(file) ? readJsonl(file) : [];
}

// Marks are ordered by time (a hand-edited file or a --now can put them out of order); one without a
// parseable time is no mark. A stage lasts until the next mark, the last one until finishedAt.
export function stageTimings(entries, finishedAt) {
  const marks = entries
    .filter((e) => typeof e.stage === 'string' && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)))
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((m) => m.e);
  return marks.map((e, i) => ({ stage: e.stage, model: e.model, effort: e.effort, startedAt: e.at, seconds: seconds(e.at, marks[i + 1]?.at ?? finishedAt) }));
}

export function loadUsage(runDir, { from, to } = {}) {
  let sessions;
  try { sessions = JSON.parse(readFileSync(path.join(runDir, 'session.json'), 'utf8')).sessions; } catch { return null; }
  if (!Array.isArray(sessions)) return null;
  const parsed = sessions.filter((s) => typeof s?.transcriptPath === 'string' && existsSync(s.transcriptPath)).map((s) => {
    const files = sessionFiles(s.transcriptPath);
    return { main: readJsonl(files.main), subagents: files.subagents.map(readJsonl) };
  });
  return parsed.length ? usageFromTranscripts(parsed, { from, to }) : null;
}

const NULL_TOKENS = Object.freeze({ input: null, output: null, cacheRead: null, cacheWrite: null, subagents: null });

export function buildRun({ key, runId, lane, mode, kind, pluginVersion, sessionEffort, stages, now = new Date(), usage, grade = null, fixRunsBefore, reviewVerdict = null, stoppedAt = null, size }) {
  const finishedAt = iso(now);
  const timings = stageTimings(stages, finishedAt);
  const startedAt = timings[0]?.startedAt ?? finishedAt;
  return {
    key, runId, lane, mode, kind, pluginVersion, sessionEffort,
    stages: timings,
    startedAt, finishedAt, seconds: seconds(startedAt, finishedAt),
    tokens: usage ? usage.tokens : { ...NULL_TOKENS },
    contextPeak: usage?.contextPeak ?? null,
    pausesOverCacheTtl: usage?.pausesOverCacheTtl ?? null,
    usd: usage?.usd ?? null,
    usdSubagents: usage?.usdSubagents ?? null,
    models: usage?.models ?? [],
    // readyAt, mergedAt and closedAt happen after the PR opens; metrics reads them from GitHub.
    outcome: { grade, fixRunsBefore, reviewVerdict, stoppedAt, readyAt: null, mergedAt: null, closedAt: null },
    size,
    scores: null,
  };
}

// A repo may carry a run.json edited by hand. One that does not parse, or has no runs array, is an
// error naming the file: it is never replaced, because that would drop the runs already recorded.
export function readRunFile(file) {
  if (!existsSync(file)) return { version: 1, runs: [] };
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { throw new Error(`${file} is not valid JSON (${err.message}); fix or remove it`); }
  if (data === null || typeof data !== 'object' || !Array.isArray(data.runs)) throw new Error(`${file} has no runs array; fix or remove it`);
  return data;
}

export function appendRun(file, run) {
  const data = readRunFile(file);
  data.runs.push(run);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

const formatTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function summaryLine({ runs = [] } = {}) {
  if (!runs.length) return null;
  const ship = runs.filter((r) => r.kind === 'ship').length;
  const parts = [`${runs.length} run${runs.length === 1 ? '' : 's'} (${ship} ship, ${runs.length - ship} fix)`, `${Math.round(runs.reduce((s, r) => s + (r.seconds ?? 0), 0) / 60)} min`];
  const reported = runs.filter((r) => Number.isFinite(r.tokens?.input));
  if (reported.length) {
    const total = reported.reduce((s, r) => s + r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite, 0);
    const reads = reported.reduce((s, r) => s + r.tokens.cacheRead, 0);
    parts.push(`${formatTokens(total)} tokens (${total ? Math.round((100 * reads) / total) : 0}% cache reads)`);
  }
  const priced = runs.filter((r) => typeof r.usd === 'number');
  if (priced.length) parts.push(`$${priced.reduce((s, r) => s + r.usd, 0).toFixed(2)}`);
  const missing = runs.length - priced.length;
  if (missing) parts.push(`cost not reported for ${missing} run${missing === 1 ? '' : 's'}`);
  return parts.join(', ');
}
