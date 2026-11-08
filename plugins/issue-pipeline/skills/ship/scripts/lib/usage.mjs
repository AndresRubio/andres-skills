import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PRICES } from './prices.mjs';

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const add = (a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
const sum4 = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function fromApiUsage(x) {
  const u = x ?? {};
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}
function fromModelUsage(m) {
  const u = m ?? {};
  return {
    input: u.inputTokens ?? u.input_tokens ?? 0,
    output: u.outputTokens ?? u.output_tokens ?? 0,
    cacheRead: u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0,
  };
}

// A headless `claude -p --output-format json` result. `modelUsage` covers the whole tree. `usage` covers
// the final turn only (the Task 6 fixture shows it far below the main loop's total), so the result
// cannot say how much of the tree was subagents: `subagents` is null, and the transcripts supply it.
// A resumed session's result includes its earlier spend: never sum results across resumes.
export function tokensFromResult(result) {
  const models = Object.values(result?.modelUsage ?? {});
  // No modelUsage means the tokens are unknown, which zeros would claim to know.
  const tree = models.length ? models.map(fromModelUsage).reduce(add, zero()) : { input: null, output: null, cacheRead: null, cacheWrite: null };
  return {
    tokens: { ...tree, subagents: null },
    usd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
  };
}

export function readJsonl(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(v); // a bare `null` or number is no entry
    } catch { /* a torn last line while the session writes */ }
  }
  return out;
}

// The main transcript and its subagent transcripts (<dir>/<session>/subagents/*.jsonl), the layout
// the Task 6 fixture shows. Subagent entries carry isSidechain true there; the main file has none,
// but usageFromTranscripts also treats a sidechain entry in the main file as a subagent's.
export function sessionFiles(transcriptPath) {
  const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
  const subagents = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f)) : [];
  return { main: transcriptPath, subagents };
}

// The regexes run on a model id (a short config string), each anchored at the end with a fixed-width
// or literal tail, so they are linear.
export function priceOf(model, prices = PRICES) {
  const id = String(model ?? '').replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
  return Object.hasOwn(prices, id) ? prices[id] : null;
}

export function messageUsd(model, usage, prices = PRICES) {
  const p = priceOf(model, prices);
  if (!p) return null;
  const t = fromApiUsage(usage);
  const rates = p.longContext && t.input + t.cacheRead + t.cacheWrite > p.longContext.over ? { ...p, ...p.longContext } : p;
  const split = usage?.cache_creation;
  const w1h = split?.ephemeral_1h_input_tokens ?? 0;
  const split5m = split?.ephemeral_5m_input_tokens ?? 0;
  // Writes the split does not account for are priced at the 5-minute rate, the API's default TTL.
  const w5m = split5m + Math.max(0, t.cacheWrite - split5m - w1h);
  const parts = [[t.input, rates.input], [t.output, rates.output], [t.cacheRead, rates.cacheRead], [w5m, rates.cacheWrite5m], [w1h, rates.cacheWrite1h]];
  let usd = 0;
  for (const [tokens, rate] of parts) {
    if (!tokens) continue;
    if (typeof rate !== 'number') return null;
    usd += (tokens * rate) / 1e6;
  }
  return usd;
}

const isStep = (e) => e && (e.type === 'user' || e.type === 'assistant') && e.isSidechain !== true;

export function usageFromTranscripts(sessions, { from, to, cacheTtlMinutes = 60, prices = PRICES } = {}) {
  // Bounds and entries are compared as parsed times: the pipeline's markers have second precision and
  // transcripts carry milliseconds, and string order puts '.' before 'Z'. An entry whose timestamp does
  // not parse is out of any window; with no window every entry is in.
  // A bound that does not parse is absent: the caller passes machine-written marks, so a bad one is
  // not worth discarding the whole run's usage for.
  const bound = (x) => { const t = x ? Date.parse(x) : NaN; return Number.isFinite(t) ? t : null; };
  const fromMs = bound(from);
  const toMs = bound(to);
  const inWindow = (e) => {
    if (fromMs === null && toMs === null) return true;
    const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    return Number.isFinite(t) && (fromMs === null || t >= fromMs) && (toMs === null || t <= toMs);
  };
  // One API message is written on several lines (same message.id) while it streams, and an early line
  // can carry a partial output_tokens. Collect per id and let the last line win.
  const byId = new Map();
  let anonymous = 0;
  const take = (e, fromSubagentFile) => {
    if (!e || e.type !== 'assistant' || !e.message?.usage || !inWindow(e)) return;
    if (sum4(fromApiUsage(e.message.usage)) === 0) return; // synthetic entries carry no spend, and must not replace a real line
    const id = e.message.id ?? e.requestId ?? `anonymous:${anonymous++}`;
    byId.set(id, { e, subagent: fromSubagentFile || e.isSidechain === true });
  };
  let pauses = 0;
  for (const s of sessions) {
    for (const e of s.main) take(e, false);
    for (const file of s.subagents) for (const e of file) take(e, true);
    const steps = s.main.filter((e) => isStep(e) && inWindow(e)).map((e) => Date.parse(e.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
    for (let i = 1; i < steps.length; i += 1) if (steps[i] - steps[i - 1] > cacheTtlMinutes * 60_000) pauses += 1;
  }
  let tokens = zero();
  let sub = zero();
  let usd = 0;
  let usdSubagents = 0;
  let contextPeak = null;
  const models = new Set();
  const unpriced = new Set();
  for (const { e, subagent } of byId.values()) {
    const t = fromApiUsage(e.message.usage);
    tokens = add(tokens, t);
    if (subagent) sub = add(sub, t);
    else contextPeak = Math.max(contextPeak ?? 0, t.input + t.cacheRead + t.cacheWrite);
    models.add(e.message.model);
    const cost = messageUsd(e.message.model, e.message.usage, prices);
    if (cost === null) unpriced.add(e.message.model);
    else { usd += cost; if (subagent) usdSubagents += cost; }
  }
  if (models.size === 0) return null;
  const priced = unpriced.size === 0;
  return {
    tokens: { ...tokens, subagents: sum4(sub) },
    contextPeak,
    pausesOverCacheTtl: pauses,
    usd: priced ? round6(usd) : null,
    usdSubagents: priced ? round6(usdSubagents) : null,
    models: [...models].sort(),
    unpriced: [...unpriced].sort(),
  };
}
