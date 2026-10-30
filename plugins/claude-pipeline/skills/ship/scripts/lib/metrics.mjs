// metrics (spec §7.5; amendment I columns). Pure: rows in, one summary per repo out.
// run.json comes from a PR head that anyone with push access can edit, so every field is read defensively:
// a run with a missing or wrong-typed field drops out of the figure that needs it and never throws.
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const finite = (xs) => xs.filter(isNum);
const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const median = (xs) => {
  const s = finite(xs).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => { const s = finite(xs); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const TASK = { compliant: 1, partial: 0.5, non_compliant: 0 };
const REVIEW = { actionable: 1, vague: 0.5, empty_or_noise: 0 };
const weight = (table, name) => (typeof name === 'string' && Object.hasOwn(table, name) ? table[name] : undefined);
const runsOf = (row) => (Array.isArray(row?.runs) ? row.runs.filter(plain) : []);
const time = (x) => (typeof x === 'string' ? Date.parse(x) : Number.NaN);

// A key's cost counts only when every one of its runs reported one.
const keyUsd = (runs) => (runs.length && runs.every((r) => isNum(r.usd)) ? runs.reduce((s, r) => s + r.usd, 0) : null);
const lockToReady = (runs, readyAt) => {
  const start = Math.min(...finite(runs.map((r) => time(r.startedAt))));
  const end = time(readyAt);
  return Number.isFinite(start) && Number.isFinite(end) ? (end - start) / 60_000 : null;
};

export function aggregate(rows) {
  const all = rows.filter(plain).map((row) => ({ row, runs: runsOf(row) }));
  const runs = all.flatMap((r) => r.runs);
  const withPr = all.filter((r) => plain(r.row.pr));
  const ready = withPr.filter((r) => r.row.pr.readyAt);
  const reported = runs.filter((r) => plain(r.tokens) && ['input', 'cacheRead', 'cacheWrite'].every((k) => isNum(r.tokens[k])));
  const inputSide = reported.reduce((s, r) => s + r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite, 0);
  const priced = runs.filter((r) => isNum(r.usd) && isNum(r.usdSubagents));
  const usd = priced.reduce((s, r) => s + r.usd, 0);
  return {
    keys: all.length,
    runs: runs.length,
    readyRate: withPr.length ? ready.length / withPr.length : null,
    medianUsdPerReady: median(ready.map((r) => keyUsd(r.runs))),
    medianMinutesLockToReady: median(ready.map((r) => lockToReady(r.runs, r.row.pr.readyAt))),
    fixRunsPerPr: withPr.length ? withPr.reduce((s, r) => s + r.runs.filter((x) => x.kind === 'fix').length, 0) / withPr.length : null,
    decisionShare: all.length ? all.filter((r) => r.row.decision === true).length / all.length : null,
    meanTaskCompliance: mean(all.map((r) => weight(TASK, r.row.score?.taskCompliance))),
    meanReviewQuality: mean(all.map((r) => weight(REVIEW, r.row.score?.reviewQuality))),
    scored: all.filter((r) => r.row.score).length,
    cacheWriteShare: inputSide ? reported.reduce((s, r) => s + r.tokens.cacheWrite, 0) / inputSide : null,
    subagentCostShare: usd ? priced.reduce((s, r) => s + r.usdSubagents, 0) / usd : null,
    medianContextPeak: median(runs.map((r) => r.contextPeak)),
  };
}

const na = (x, f) => (x === null || x === undefined ? 'n/a' : f(x));
const pct = (x) => `${Math.round(x * 100)}%`;
const kTokens = (x) => (x >= 1000 ? `${Math.round(x / 1000)}k` : String(x));

export function formatTable(repo, s) {
  const head = ['Repo', 'Runs', 'Ready rate', 'Median $ per ready PR', 'Median min lock to ready', 'Fix runs per PR', 'Needed a decision', 'Task compliance', 'Review quality', 'Cache-write share', 'Subagent cost share', 'Median context peak'];
  const row = [
    repo, String(s.runs), na(s.readyRate, pct), na(s.medianUsdPerReady, (x) => `$${x.toFixed(2)}`),
    na(s.medianMinutesLockToReady, (x) => String(Math.round(x))), na(s.fixRunsPerPr, (x) => x.toFixed(2)), na(s.decisionShare, pct),
    na(s.meanTaskCompliance, (x) => `${x.toFixed(2)} (${s.scored})`), na(s.meanReviewQuality, (x) => `${x.toFixed(2)} (${s.scored})`),
    na(s.cacheWriteShare, pct), na(s.subagentCostShare, pct), na(s.medianContextPeak, kTokens),
  ];
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, `| ${row.join(' | ')} |`].join('\n');
}
