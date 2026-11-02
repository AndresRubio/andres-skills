import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, formatTable } from '../skills/ship/scripts/lib/metrics.mjs';
import { collectRows } from '../skills/ship/scripts/lib/metrics-run.mjs';
import { formatScoreBody } from '../skills/ship/scripts/lib/score.mjs';
import { formatVerdictBody } from '../skills/ship/scripts/lib/verdict.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';

const run = (kind, startedAt, usd, extra = {}) => ({
  kind, startedAt, usd, usdSubagents: usd === null ? null : usd / 4, contextPeak: 50_000,
  tokens: { input: 100, output: 100, cacheRead: 700, cacheWrite: 200, subagents: 100 }, ...extra,
});
const rows = [
  { key: '1', pr: { number: 11, readyAt: '2026-10-20T11:00:00Z', mergedAt: '2026-10-20T12:00:00Z', closedAt: null }, runs: [run('ship', '2026-10-20T10:00:00Z', 2), run('fix', '2026-10-20T10:40:00Z', 1)], decision: false, score: { taskCompliance: 'compliant', reviewQuality: 'vague' } },
  { key: '2', pr: { number: 12, readyAt: '2026-10-20T10:30:00Z', mergedAt: null, closedAt: null }, runs: [run('ship', '2026-10-20T10:00:00Z', 4)], decision: false, score: null },
  { key: '3', pr: { number: 13, readyAt: null, mergedAt: null, closedAt: '2026-10-20T13:00:00Z' }, runs: [run('ship', '2026-10-20T10:00:00Z', null, { contextPeak: 90_000 })], decision: true, score: null },
  { key: '4', pr: { number: 14, readyAt: null, mergedAt: null, closedAt: null }, runs: [], decision: false, score: null },
];

test('aggregate computes the spec §7.5 columns and the amendment I columns', () => {
  const s = aggregate(rows);
  assert.equal(s.keys, 4);
  assert.equal(s.runs, 4);
  assert.equal(s.readyRate, 0.5);
  assert.equal(s.medianUsdPerReady, 3.5);
  assert.equal(s.medianMinutesLockToReady, 45);
  assert.equal(s.fixRunsPerPr, 0.25);
  assert.equal(s.decisionShare, 0.25);
  assert.equal(s.meanTaskCompliance, 1);
  assert.equal(s.meanReviewQuality, 0.5);
  assert.equal(s.scored, 1);
  assert.equal(s.cacheWriteShare, 0.2);
  assert.equal(s.subagentCostShare, 0.25);
  assert.equal(s.medianContextPeak, 50_000);
});

test('aggregate of nothing is nulls, not an error', () => {
  const s = aggregate([]);
  assert.equal(s.readyRate, null);
  assert.equal(s.medianUsdPerReady, null);
  assert.equal(s.cacheWriteShare, null);
});

test('formatTable prints one row per repo and n/a for nulls', () => {
  const t = formatTable('o/r', aggregate(rows));
  assert.match(t, /^\| Repo \| Runs \| Ready rate \| Median \$ per ready PR \| Median min lock to ready \| Fix runs per PR \| Needed a decision \| Task compliance \| Review quality \| Cache-write share \| Subagent cost share \| Median context peak \|$/m);
  assert.match(t, /^\| o\/r \| 4 \| 50% \| \$3\.50 \| 45 \| 0\.25 \| 25% \| 1\.00 \(1\) \| 0\.50 \(1\) \| 20% \| 25% \| 50k \|$/m);
  assert.match(formatTable('o/r', aggregate([])), /\| o\/r \| 0 \| n\/a \|/);
});

test('collectRows reads run.json at each claude/* PR head and the ready, verdict and score comments from GitHub', () => {
  const marked = (kind, at, body = '') => ({ id: at, pipeline: true, marker: { kind }, createdAt: at, body: `**[claude-pipeline]** ${kind} · ${at} · local\n\n${body}` });
  const score = formatScoreBody({ marker: '**[claude-pipeline]** score · 2026-10-20T11:05:00Z · local', head: 'a'.repeat(40), score: { taskCompliance: 'partial', reviewQuality: 'actionable', reasons: { taskCompliance: 'x', reviewQuality: 'y' } } });
  const deps = {
    listPrs: () => [
      { number: 11, headRefName: 'claude/1-a', headRefOid: 'a'.repeat(40), isCrossRepository: false, state: 'MERGED', createdAt: '2026-10-20T09:00:00Z', closedAt: '2026-10-20T12:00:00Z', mergedAt: '2026-10-20T12:00:00Z', body: 'Fixes #1' },
      { number: 12, headRefName: 'claude/2-b', headRefOid: 'b'.repeat(40), isCrossRepository: false, state: 'CLOSED', createdAt: '2026-10-20T09:00:00Z', closedAt: '2026-10-20T13:00:00Z', mergedAt: null, body: 'Fixes #2' },
      { number: 13, headRefName: 'feature/x', headRefOid: 'c'.repeat(40), isCrossRepository: false, state: 'OPEN', createdAt: '2026-10-20T09:00:00Z', body: '' },
      { number: 14, headRefName: 'claude/4-d', headRefOid: 'd'.repeat(40), isCrossRepository: true, state: 'OPEN', createdAt: '2026-10-20T09:00:00Z', body: 'Fixes #4' },
      { number: 15, headRefName: 'claude/5-e', headRefOid: 'e'.repeat(40), isCrossRepository: false, state: 'OPEN', createdAt: '2026-10-01T09:00:00Z', body: 'Fixes #5' },
    ],
    runJson: (sha, key) => (key === '1' ? { version: 1, runs: [{ kind: 'ship' }] } : null),
    prComments: (n) => (n === 11 ? [marked('ready', '2026-10-20T11:00:00Z'), marked('ready', '2026-10-20T11:30:00Z'), { ...marked('score', '2026-10-20T11:05:00Z'), body: score }] : []),
    issueComments: (n) => (n === 2 ? [marked('questions', '2026-10-20T09:30:00Z')] : []),
  };
  const r = collectRows('o/r', { since: '2026-10-10T00:00:00Z' }, deps);
  assert.deepEqual(r.map((x) => x.key), ['1', '2']);
  assert.deepEqual(r[0].pr, { number: 11, readyAt: '2026-10-20T11:00:00Z', mergedAt: '2026-10-20T12:00:00Z', closedAt: null });
  assert.deepEqual(r[0].score, { taskCompliance: 'partial', reviewQuality: 'actionable' });
  assert.deepEqual(r[1].runs, []);
  assert.equal(r[1].decision, true);
  assert.equal(r[1].pr.closedAt, '2026-10-20T13:00:00Z');
});

const baseDeps = (prs, extra = {}) => ({ listPrs: () => prs, runJson: () => null, prComments: () => [], issueComments: () => [], ...extra });
const pr = (number, createdAt, extra = {}) => ({ number, headRefName: `claude/${number}-x`, headRefOid: 'a'.repeat(40), isCrossRepository: false, state: 'OPEN', createdAt, body: '', ...extra });

test('collectRows compares --since as times, inclusive, whatever the precision', () => {
  const prs = [pr(1, '2026-10-10T00:00:00Z'), pr(2, '2026-10-09T23:59:59.999Z'), pr(3, '2026-10-10T00:00:00.500Z'), pr(4, 'not a date')];
  assert.deepEqual(collectRows('o/r', { since: '2026-10-10T00:00:00.000Z' }, baseDeps(prs)).map((r) => r.pr.number), [1, 3]);
  assert.deepEqual(collectRows('o/r', {}, baseDeps(prs)).map((r) => r.pr.number), [1, 2, 3, 4]);
  assert.throws(() => collectRows('o/r', { since: 'yesterday' }, baseDeps(prs)), /--since/);
});

test('collectRows keeps only plain-object entries of a run.json written by anyone with push access', () => {
  const runs = [null, 'x', 7, [], { kind: 'ship', usd: 2 }, undefined];
  const r = collectRows('o/r', {}, baseDeps([pr(1, '2026-10-20T09:00:00Z')], { runJson: () => ({ runs }) }));
  assert.deepEqual(r[0].runs, [{ kind: 'ship', usd: 2 }]);
  for (const bad of [{ runs: 'x' }, { runs: null }, [], 'x', 5, null]) {
    assert.deepEqual(collectRows('o/r', {}, baseDeps([pr(1, '2026-10-20T09:00:00Z')], { runJson: () => bad }))[0].runs, []);
  }
});

test('collectRows counts a human-decision-needed verdict from the owner, not one from a stranger', () => {
  const body = formatVerdictBody({ verdict: 'human-decision-needed', head: 'a'.repeat(40), findings: [], diffRisk: [], reason: 'review did not complete', marker: '**[claude-pipeline]** verdict · 2026-10-20T10:00:00Z · local' });
  const comment = (author, authorAssociation) => ({ id: 1, pipeline: true, author, authorAssociation, marker: { kind: 'verdict' }, createdAt: '2026-10-20T10:00:00Z', body });
  const rowFor = (c) => collectRows('o/r', {}, baseDeps([pr(1, '2026-10-20T09:00:00Z')], { prComments: () => [c] }))[0];
  assert.equal(rowFor(comment('AndresRubio', 'OWNER')).decision, true);
  assert.equal(rowFor(comment('someone', 'CONTRIBUTOR')).decision, false);
});

test('collectRows takes the earliest ready comment by time', () => {
  const ready = (at) => ({ id: at, pipeline: true, marker: { kind: 'ready' }, createdAt: at, body: '' });
  const looked = [];
  const prs = [pr(1, '2026-10-20T09:00:00Z')];
  const r = collectRows('o/r', {}, baseDeps(prs, {
    prComments: () => [ready('2026-10-20T11:30:00Z'), ready('2026-10-20T11:00:00.500Z'), ready('2026-10-20T11:00:00Z')],
    runJson: (sha, key) => { looked.push(key); return null; },
  }));
  assert.equal(r[0].pr.readyAt, '2026-10-20T11:00:00Z');
  assert.deepEqual(looked, ['1']);
});

test('aggregate shrugs off a run with missing or wrong-typed tokens, usd, startedAt and contextPeak', () => {
  const bad = [
    { kind: 'ship' },
    { kind: 'ship', usd: 'x', usdSubagents: 'y', startedAt: 'nope', contextPeak: 'big', tokens: { input: 'a', cacheRead: null } },
    { kind: 'fix', usd: Number.NaN, tokens: {}, startedAt: 5 },
    { kind: 'ship', tokens: 'text', startedAt: null, contextPeak: {} },
  ];
  const messy = [
    { key: '1', pr: { number: 1, readyAt: '2026-10-20T11:00:00Z', mergedAt: null, closedAt: null }, runs: bad, decision: false, score: { taskCompliance: 'weird', reviewQuality: undefined } },
    { key: '2', pr: { number: 2, readyAt: 'not a time', mergedAt: null, closedAt: null }, runs: [run('ship', '2026-10-20T10:00:00Z', 4)], decision: false, score: null },
    { key: '3', pr: null, runs: [], decision: false, score: null },
  ];
  const s = aggregate(messy);
  assert.equal(s.runs, 5);
  // Row 2 has a readyAt that is not a time, so it is not a ready PR and its cost is not a cost per ready PR.
  assert.equal(s.medianUsdPerReady, null);
  assert.equal(s.medianMinutesLockToReady, null);
  assert.equal(s.cacheWriteShare, 0.2);
  assert.equal(s.subagentCostShare, 0.25);
  assert.equal(s.medianContextPeak, 50_000);
  assert.equal(s.meanTaskCompliance, null);
  for (const [k, v] of Object.entries(s)) if (!['truncated', 'errors'].includes(k)) assert.ok(v === null || Number.isFinite(v), `${k} = ${v}`);
  assert.doesNotThrow(() => formatTable('o/r', s));
  assert.doesNotThrow(() => aggregate([{ key: '9', pr: { number: 9 }, runs: [], decision: false, score: null }]));
});

test('CLI metrics refuses a bad --since and a --repo that is not owner/name before any gh call', () => {
  const env = { PATH: '/nonexistent' };
  for (const args of [['--since', 'yesterday'], ['--repo', 'o'], ['--repo', '--flag'], ['--repo', 'o/r/extra'], ['--repo', 'o/r', '--repo', '../x']]) {
    const r = runCli(['metrics', ...args], { env });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
  }
});

test('CLI metrics prints JSON, or one table per repo with --table, from the GitHub data', () => {
  const sha = 'a'.repeat(40);
  const runJson = Buffer.from(JSON.stringify({ version: 1, runs: [run('ship', '2026-10-20T10:00:00Z', 2)] })).toString('base64');
  const dir = fakeGh({
    'pr list --repo o/r --state all --limit 500 --json number,headRefName,headRefOid,isCrossRepository,state,createdAt,closedAt,mergedAt,body': [
      { number: 11, headRefName: 'claude/1-a', headRefOid: sha, isCrossRepository: false, state: 'MERGED', createdAt: '2026-10-20T09:00:00Z', closedAt: '2026-10-20T12:00:00Z', mergedAt: '2026-10-20T12:00:00Z', body: 'Fixes #1' },
    ],
    // The narrowed query is served different data (nothing), so the --since call is proven to send --search.
    'pr list --repo o/r --state all --limit 500 --search created:>=2026-10-01 --json number,headRefName,headRefOid,isCrossRepository,state,createdAt,closedAt,mergedAt,body': [],
    [`api repos/o/r/contents/docs/pipeline/1/run.json?ref=${sha}`]: { content: runJson },
    'api --paginate --slurp repos/o/r/issues/11/comments': [[]],
    'api --paginate --slurp repos/o/r/issues/1/comments': [[]],
  });
  const env = { PATH: `${dir}:${process.env.PATH}` };
  const json = runCli(['metrics', '--repo', 'o/r'], { env });
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.json().repos[0].repo, 'o/r');
  assert.equal(json.json().repos[0].runs, 1);
  const table = runCli(['metrics', '--repo', 'o/r', '--table', '--since', '2026-10-01T00:00:00Z'], { env });
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /^\| o\/r \| 0 \|/m, 'the --since query reached gh as --search and returned no PRs');
});

test('collectRows warns on stderr and flags truncated when pr list returns exactly 500 PRs', () => {
  const warnings = [];
  const prs = Array.from({ length: 500 }, (_, i) => pr(i + 1, '2026-10-20T09:00:00Z'));
  const r = collectRows('o/r', {}, baseDeps(prs, { warn: (m) => warnings.push(m) }));
  assert.equal(r.truncated, true);
  assert.deepEqual(warnings, ['o/r: pr list hit the 500 limit; older PRs are not counted']);
  const s = aggregate(r);
  assert.equal(s.truncated, true);
  assert.match(formatTable('o/r', s), /^\| o\/r \| 0\* \|/m);
  const short = collectRows('o/r', {}, baseDeps(prs.slice(0, 499), { warn: (m) => warnings.push(m) }));
  assert.equal(short.truncated, false);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(formatTable('o/r', aggregate(short)), /\*/);
});

test('collectRows writes the truncation warning to stderr as one JSON line by default', () => {
  const prs = Array.from({ length: 500 }, (_, i) => pr(i + 1, '2026-10-20T09:00:00Z'));
  const written = [];
  const real = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try { collectRows('o/r', {}, baseDeps(prs)); } finally { process.stderr.write = real; }
  assert.deepEqual(written, ['{"warning":"o/r: pr list hit the 500 limit; older PRs are not counted"}\n']);
});

test('collectRows hands --since to listPrs as a UTC date so the query can be narrowed server side', () => {
  const seen = [];
  collectRows('o/r', { since: '2026-10-10T12:00:00Z' }, baseDeps([], { listPrs: (q) => { seen.push(q); return []; } }));
  collectRows('o/r', {}, baseDeps([], { listPrs: (q) => { seen.push(q); return []; } }));
  assert.deepEqual(seen, [{ since: '2026-10-10' }, { since: null }]);
});

test('collectRows isolates a failing comments fetch to its own row and collects the error', () => {
  const ready = { id: 1, pipeline: true, marker: { kind: 'ready' }, createdAt: '2026-10-20T11:00:00Z', body: '' };
  const prs = [pr(1, '2026-10-20T09:00:00Z'), pr(2, '2026-10-20T09:00:00Z', { body: 'Fixes #9' }), pr(3, '2026-10-20T09:00:00Z', { body: 'Fixes #3' })];
  const r = collectRows('o/r', {}, baseDeps(prs, {
    prComments: (n) => { if (n === 2) throw new Error('HTTP 502'); return [ready]; },
    issueComments: (n) => { if (n === 3) throw new Error('HTTP 500'); return []; },
  }));
  assert.equal(r.length, 3);
  assert.equal(r[0].pr.readyAt, '2026-10-20T11:00:00Z');
  for (const row of [r[1], r[2]]) {
    assert.equal(row.pr.readyAt, null);
    assert.equal(row.decision, false);
    assert.equal(row.score, null);
  }
  assert.deepEqual(r.errors, ['PR #2: HTTP 502', 'PR #3: HTTP 500']);
  assert.deepEqual(aggregate(r).errors, r.errors);
  assert.doesNotThrow(() => formatTable('o/r', aggregate(r)));
});

test('collectRows counts a blocked or questions comment on the PR itself as a decision', () => {
  const on = (kind) => collectRows('o/r', {}, baseDeps([pr(1, '2026-10-20T09:00:00Z')], { prComments: () => [{ id: 1, pipeline: true, marker: { kind }, createdAt: '2026-10-20T10:00:00Z', body: '' }] }))[0].decision;
  assert.equal(on('blocked'), true);
  assert.equal(on('questions'), true);
  assert.equal(on('ready'), false);
});

test('collectRows skips a claude/ branch without a pipeline key and counts it in skipped', () => {
  const prs = [pr(1, '2026-10-20T09:00:00Z'), { ...pr(2, '2026-10-20T09:00:00Z'), headRefName: 'claude/odd name' }, { ...pr(3, '2026-10-20T09:00:00Z'), headRefName: 'claude/' }];
  const r = collectRows('o/r', {}, baseDeps(prs));
  assert.deepEqual(r.map((x) => x.key), ['1']);
  assert.equal(r.skipped, 2);
  const s = aggregate(r);
  assert.equal(s.skipped, 2);
  assert.equal(s.keys, 1);
});

test('lockToReady gives no figure when the ready time is before the earliest start', () => {
  const early = { key: '1', pr: { number: 1, readyAt: '2026-10-20T09:00:00Z' }, runs: [run('ship', '2026-10-20T10:00:00Z', 1)], decision: false, score: null };
  assert.equal(aggregate([early]).medianMinutesLockToReady, null);
  const same = { ...early, pr: { number: 1, readyAt: '2026-10-20T10:00:00Z' } };
  assert.equal(aggregate([same]).medianMinutesLockToReady, 0);
});

test('lockToReady takes the earliest start across many runs without spreading them', () => {
  const many = Array.from({ length: 200_000 }, (_, i) => run('fix', new Date(Date.UTC(2026, 9, 20, 11) + i * 1000).toISOString(), 0));
  many.push(run('ship', '2026-10-20T10:00:00Z', 1));
  const row = { key: '1', pr: { number: 1, readyAt: '2026-10-20T10:30:00Z' }, runs: many, decision: false, score: null };
  assert.equal(aggregate([row]).medianMinutesLockToReady, 30);
});

test('readyRate counts a PR only when its readyAt is a real time', () => {
  const mk = (readyAt) => ({ key: '1', pr: { number: 1, readyAt }, runs: [], decision: false, score: null });
  assert.equal(aggregate([mk('2026-10-20T10:00:00Z'), mk('garbage'), mk(5), mk(null)]).readyRate, 0.25);
});

test('the context peak prints as 999, 1k and 1.0M at the boundaries', () => {
  const cell = (n) => formatTable('o/r', { runs: 1, medianContextPeak: n }).split('\n')[2].split(' | ').at(-1).replace(' |', '');
  assert.equal(cell(999), '999');
  assert.equal(cell(1000), '1k');
  assert.equal(cell(1_000_000), '1.0M');
  assert.equal(cell(50_000), '50k');
});
