// run.json (spec §7.5, D19; cost fields from amendment I). Written by the run itself, in the last
// commit before a push, so writing it never re-runs a PR's checks.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonl, sessionFiles, usageFromTranscripts } from './usage.mjs';

const S = Object.freeze({ model: 'session', effort: 'session' });
// The Model policy table in skills/ship/SKILL.md, one row per stage. "session": the orchestrating
// session does the stage itself. Stage 10 posts the report comment and clears labels, which the
// table's "Tracker queries, labels" row covers. Fix mode marks its inline steps as `fix`; stages 7 and
// 8 inside fix mode are marked on their own.
// The policy for a dispatch, not a measurement: `models` and `usd` come from the transcript, and
// `effort` here is the table's value while `sessionEffort` is what the run was started with.
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
  fix: S,
});

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const seconds = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));

export function stageMark(runDir, { stage, model, effort, now = new Date() }) {
  const key = String(stage);
  if (!Object.hasOwn(STAGE_POLICY, key)) throw new Error(`unknown stage ${key}`);
  const entry = { stage: key, at: iso(now), model: model || STAGE_POLICY[key].model, effort: effort || STAGE_POLICY[key].effort };
  const file = path.join(runDir, 'stages.jsonl');
  // A torn last line (a killed write) must not swallow this mark: start a fresh line.
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const torn = text !== '' && !text.endsWith('\n');
  appendFileSync(file, `${torn ? '\n' : ''}${JSON.stringify(entry)}\n`);
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

// Recording must never stop a push: any failure reading the transcripts means "usage not reported".
export function loadUsage(runDir, { from, to } = {}) {
  try {
    const sessions = JSON.parse(readFileSync(path.join(runDir, 'session.json'), 'utf8')).sessions;
    if (!Array.isArray(sessions)) return null;
    const parsed = sessions.filter((s) => typeof s?.transcriptPath === 'string' && existsSync(s.transcriptPath)).map((s) => {
      const files = sessionFiles(s.transcriptPath);
      return { main: readJsonl(files.main), subagents: files.subagents.map(readJsonl) };
    });
    return parsed.length ? usageFromTranscripts(parsed, { from, to }) : null;
  } catch {
    return null;
  }
}

const NULL_TOKENS = Object.freeze({ input: null, output: null, cacheRead: null, cacheWrite: null, subagents: null });

export function buildRun({ key, runId, lane, mode, kind, pluginVersion, sessionEffort, stages, now = new Date(), usage, grade = null, fixRunsBefore, reviewVerdict = null, stoppedAt = null, size }) {
  // A mark can be dated after --now (a hand-set clock, a skewed host): the run never finishes before its last mark.
  const lastMark = Math.max(...stageTimings(stages, iso(now)).map((t) => Date.parse(t.startedAt)), -Infinity);
  const finishedAt = iso(Math.max(new Date(now).getTime(), lastMark));
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
    unpriced: usage?.unpriced ?? [],
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
  if (!data.runs.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) throw new Error(`${file} has a runs entry that is not an object; fix or remove it`);
  return data;
}

export function sameRun(a, b) {
  return Boolean(a) && a.runId === b.runId && a.kind === b.kind;
}

// A path in the repo can be a symlink a pusher committed. Nothing is written through one.
export function refuseSymlink(file) {
  let st = null;
  try { st = lstatSync(file); } catch { /* absent */ }
  if (st?.isSymbolicLink()) throw new Error(`${file} is a symlink; remove it`);
}

// Where the temp file goes: the run dir when it is on the same device as the target (a rename across
// devices fails with EXDEV), else beside the target. `dev` is a seam for the test.
export function tempPathFor(file, tmpDir, dev = (p) => statSync(p).dev) {
  const beside = `${file}.tmp`;
  if (!tmpDir) return beside;
  try {
    if (dev(tmpDir) === dev(path.dirname(file))) return path.join(tmpDir, `${path.basename(file)}.tmp`);
  } catch { /* an unreadable run dir: fall back */ }
  return beside;
}

// Creates `tmp` fresh: a symlink there is refused, a leftover regular file is removed, and 'wx' fails
// rather than follow a link that appears in between.
function writeFresh(tmp, text) {
  let st = null;
  try { st = lstatSync(tmp); } catch { /* absent */ }
  if (st?.isSymbolicLink()) throw new Error(`${tmp} is a symlink; remove it`);
  if (st) unlinkSync(tmp);
  writeFileSync(tmp, text, { flag: 'wx' });
}

// The same run recorded twice (a retried push) replaces its entry. The file is written to a temp file
// in `tmpDir` (the run dir, outside the repo) and renamed over the target, so a killed write never
// leaves torn JSON for the next `git add` and a link planted in the repo is never followed. Only
// { version, runs } is written: unknown keys of a hand-edited file are dropped.
export function appendRun(file, run, { tmpDir, rename = renameSync } = {}) {
  refuseSymlink(file);
  refuseSymlink(`${file}.tmp`);
  const runs = readRunFile(file).runs;
  if (sameRun(runs.at(-1), run)) runs[runs.length - 1] = run;
  else runs.push(run);
  const data = { version: 1, runs };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  let tmp = tempPathFor(file, tmpDir);
  // Only a temp file this call wrote is removed on failure: a link or file that was already there
  // (writeFresh refused it) stays, so a committed link in the worktree is never deleted here.
  let created = false;
  try {
    writeFresh(tmp, text);
    created = true;
    try {
      rename(tmp, file);
    } catch (err) {
      if (err?.code !== 'EXDEV' || tmp === `${file}.tmp`) throw err;
      unlinkSync(tmp);
      created = false;
      tmp = `${file}.tmp`;
      writeFresh(tmp, text);
      created = true;
      rename(tmp, file);
    }
  } catch (err) {
    if (created) { try { unlinkSync(tmp); } catch { /* already gone */ } }
    throw err;
  }
  return data;
}

const formatTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// run.json can be edited by anyone who can push to the branch, so a field counts only when it is a finite number.
const num = (x) => (Number.isFinite(x) ? x : 0);

export function summaryLine({ runs = [] } = {}) {
  if (!runs.length) return null;
  const ship = runs.filter((r) => r.kind === 'ship').length;
  const parts = [`${runs.length} run${runs.length === 1 ? '' : 's'} (${ship} ship, ${runs.length - ship} fix)`, `${Math.round(runs.reduce((s, r) => s + num(r.seconds), 0) / 60)} min`];
  const reported = runs.filter((r) => Number.isFinite(r.tokens?.input));
  if (reported.length) {
    const total = reported.reduce((s, r) => s + num(r.tokens.input) + num(r.tokens.output) + num(r.tokens.cacheRead) + num(r.tokens.cacheWrite), 0);
    const reads = reported.reduce((s, r) => s + num(r.tokens.cacheRead), 0);
    parts.push(`${formatTokens(total)} tokens (${total ? Math.round((100 * reads) / total) : 0}% cache reads)`);
  }
  const priced = runs.filter((r) => Number.isFinite(r.usd));
  if (priced.length) parts.push(`$${priced.reduce((s, r) => s + r.usd, 0).toFixed(2)}`);
  const missing = runs.length - priced.length;
  if (missing) parts.push(`cost not reported for ${missing} run${missing === 1 ? '' : 's'}`);
  return parts.join(', ');
}
