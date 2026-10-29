import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tokensFromResult, usageFromTranscripts, messageUsd, priceOf, readJsonl, sessionFiles } from '../skills/ship/scripts/lib/usage.mjs';

const P = {
  'm-big': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'm-small': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2, longContext: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 } },
};
const u = (input, output, cacheRead, cacheWrite, extra = {}) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, ...extra });
const msg = (id, at, model, usage, extra = {}) => ({ type: 'assistant', timestamp: at, message: { id, model, usage }, ...extra });
const user = (at) => ({ type: 'user', timestamp: at });

test('tokensFromResult: tokens are the whole tree; subagents are unknown because usage covers only the final turn', () => {
  const r = tokensFromResult({
    usage: u(10, 20, 300, 40), total_cost_usd: 0.5,
    modelUsage: { 'm-big': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 }, 'm-small': { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7, cacheCreationInputTokens: 8 } },
  });
  assert.deepEqual(r, { tokens: { input: 15, output: 26, cacheRead: 307, cacheWrite: 48, subagents: null }, usd: 0.5 });
  assert.equal(tokensFromResult({ usage: u(1, 1, 0, 0), modelUsage: {} }).usd, null);
});

test('tokensFromResult reads snake_case modelUsage', () => {
  const r = tokensFromResult({
    usage: u(10, 20, 300, 40),
    modelUsage: { 'm-big': { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
  });
  assert.deepEqual(r.tokens, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, subagents: null });
});

test('priceOf strips a date suffix and a [1m] tag; unknown models have no price', () => {
  assert.equal(priceOf('m-big-20260101', P), P['m-big']);
  assert.equal(priceOf('m-big[1m]', P), P['m-big']);
  assert.equal(priceOf('other', P), null);
  assert.equal(priceOf(undefined, P), null);
  assert.equal(priceOf('__proto__', P), null);
});

test('priceOf stays fast on a long model id', () => {
  const t0 = Date.now();
  priceOf('9'.repeat(200_000) + '[1m', P);
  priceOf('-'.repeat(200_000), P);
  assert.ok(Date.now() - t0 < 1000);
});

test('messageUsd prices cache reads and both write TTLs at their own rates, and long prompts at the long-context rates', () => {
  assert.equal(messageUsd('m-big', u(1_000_000, 0, 0, 0), P), 2);
  assert.equal(messageUsd('m-big', u(0, 0, 1_000_000, 0), P), 0.2);
  assert.equal(messageUsd('m-big', u(0, 0, 0, 1_000_000), P), 2.5);
  assert.equal(messageUsd('m-big', u(0, 0, 0, 2_000_000, { cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } }), P), 6.5);
  assert.equal(messageUsd('m-small', u(200_000, 0, 0, 0), P), 0.1);
  assert.equal(messageUsd('nope', u(1, 1, 0, 0), P), null);
  const partial = { 'm-x': { input: 1, output: 1, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null } };
  assert.equal(messageUsd('m-x', u(1_000_000, 0, 0, 0), partial), 1, 'an unknown rate matters only when its tokens are non-zero');
  assert.equal(messageUsd('m-x', u(0, 0, 5, 0), partial), null);
});

test('usageFromTranscripts dedupes by message id, splits subagents, finds the context peak and the pauses', () => {
  const main = [
    user('2026-10-20T10:00:00Z'),
    msg('a', '2026-10-20T10:00:05Z', 'm-big', u(10, 100, 5000, 2000)),
    msg('a', '2026-10-20T10:00:05Z', 'm-big', u(10, 100, 5000, 2000)),
    msg('s1', '2026-10-20T10:00:30Z', 'm-small', u(1, 2, 3, 4), { isSidechain: true }),
    user('2026-10-20T11:30:00Z'),
    msg('b', '2026-10-20T11:30:05Z', 'm-big', u(20, 50, 9000, 100)),
    msg('z', '2026-10-20T11:30:06Z', '<synthetic>', u(0, 0, 0, 0)),
  ];
  const sub = [[msg('s2', '2026-10-20T10:01:00Z', 'm-small', u(5, 6, 7, 8))]];
  const r = usageFromTranscripts([{ main, subagents: sub }], { prices: P });
  assert.deepEqual(r.tokens, { input: 36, output: 158, cacheRead: 14010, cacheWrite: 2112, subagents: 36 });
  assert.equal(r.contextPeak, 9120);
  assert.equal(r.pausesOverCacheTtl, 1);
  assert.deepEqual(r.models, ['m-big', 'm-small']);
  assert.deepEqual(r.unpriced, []);
  assert.ok(r.usd > r.usdSubagents && r.usdSubagents > 0);
  assert.equal(usageFromTranscripts([{ main, subagents: sub }], { prices: P, cacheTtlMinutes: 120 }).pausesOverCacheTtl, 0);
});

test('usageFromTranscripts: the last line per message id wins, because an early line can carry a partial output_tokens', () => {
  const main = [
    msg('a', '2026-10-20T10:00:05Z', 'm-big', u(10, 3, 5000, 2000)),
    msg('a', '2026-10-20T10:00:06Z', 'm-big', u(10, 324, 5000, 2000)),
    msg('a', '2026-10-20T10:00:06Z', 'm-big', u(10, 324, 5000, 2000)),
  ];
  const r = usageFromTranscripts([{ main, subagents: [] }], { prices: P });
  assert.deepEqual(r.tokens, { input: 10, output: 324, cacheRead: 5000, cacheWrite: 2000, subagents: 0 });
  assert.equal(r.contextPeak, 7010);
  // the same id in a subagent file is a separate message from the main loop's id of that name only if ids differ
  const sub = [[msg('a', '2026-10-20T10:00:07Z', 'm-big', u(10, 400, 5000, 2000))]];
  assert.equal(usageFromTranscripts([{ main, subagents: sub }], { prices: P }).tokens.output, 400);
});

test('usageFromTranscripts: entries with neither message.id nor requestId are each counted', () => {
  const main = [
    msg(undefined, '2026-10-20T10:00:00Z', 'm-big', u(1, 1, 0, 0)),
    msg(undefined, '2026-10-20T10:00:00Z', 'm-big', u(1, 1, 0, 0)),
    msg(undefined, '2026-10-20T10:00:01Z', 'm-big', u(1, 1, 0, 0)),
  ];
  assert.equal(usageFromTranscripts([{ main, subagents: [] }], { prices: P }).tokens.input, 3);
  const byRequest = [
    { ...msg(undefined, '2026-10-20T10:00:00Z', 'm-big', u(1, 2, 0, 0)), requestId: 'r1' },
    { ...msg(undefined, '2026-10-20T10:00:01Z', 'm-big', u(1, 9, 0, 0)), requestId: 'r1' },
  ];
  const r = usageFromTranscripts([{ main: byRequest, subagents: [] }], { prices: P });
  assert.deepEqual([r.tokens.input, r.tokens.output], [1, 9]);
});

test('usageFromTranscripts: a main transcript with no entries still counts its subagent files', () => {
  const sub = [[msg('s', '2026-10-20T10:01:00Z', 'm-small', u(5, 6, 7, 8))]];
  const r = usageFromTranscripts([{ main: [], subagents: sub }], { prices: P });
  assert.deepEqual(r.tokens, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, subagents: 26 });
  assert.equal(r.contextPeak, null);
  assert.equal(r.pausesOverCacheTtl, 0);
  assert.equal(usageFromTranscripts([{ main: [], subagents: [] }], { prices: P }), null);
});

test('usageFromTranscripts: the window excludes earlier spend; an unpriced model nulls the cost; nothing in range is null', () => {
  const main = [msg('a', '2026-10-20T09:00:00Z', 'm-big', u(1000, 0, 0, 0)), msg('b', '2026-10-20T10:00:00Z', 'mystery', u(1, 1, 0, 0))];
  const r = usageFromTranscripts([{ main, subagents: [] }], { from: '2026-10-20T09:30:00Z', prices: P });
  assert.equal(r.tokens.input, 1);
  assert.equal(r.usd, null);
  assert.deepEqual(r.unpriced, ['mystery']);
  assert.equal(usageFromTranscripts([{ main, subagents: [] }], { from: '2026-10-21T00:00:00Z', prices: P }), null);
});

test('usageFromTranscripts: from and to bound the window on both sides, inclusive', () => {
  const main = [
    msg('a', '2026-10-20T09:00:00Z', 'm-big', u(1, 0, 0, 0)),
    msg('b', '2026-10-20T10:00:00Z', 'm-big', u(10, 0, 0, 0)),
    msg('c', '2026-10-20T11:00:00Z', 'm-big', u(100, 0, 0, 0)),
    msg('d', '2026-10-20T12:00:00Z', 'm-big', u(1000, 0, 0, 0)),
  ];
  const r = usageFromTranscripts([{ main, subagents: [] }], { from: '2026-10-20T10:00:00Z', to: '2026-10-20T11:00:00Z', prices: P });
  assert.equal(r.tokens.input, 110);
});

test('usageFromTranscripts counts the spend of several sessions together', () => {
  const s1 = { main: [msg('a', '2026-10-20T10:00:00Z', 'm-big', u(1, 1, 0, 0))], subagents: [] };
  const s2 = { main: [msg('b', '2026-10-20T10:00:00Z', 'm-big', u(2, 2, 0, 0))], subagents: [] };
  assert.equal(usageFromTranscripts([s1, s2], { prices: P }).tokens.input, 3);
});

test('readJsonl skips a torn line and a blank line without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-'));
  try {
    const f = path.join(dir, 'a.jsonl');
    writeFileSync(f, '{"a":1}\n\n{"b":2}\n{"torn":');
    assert.deepEqual(readJsonl(f), [{ a: 1 }, { b: 2 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sessionFiles finds <session>/subagents/*.jsonl next to the main transcript, sorted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-'));
  try {
    const main = path.join(dir, 'sess-1.jsonl');
    writeFileSync(main, '');
    assert.deepEqual(sessionFiles(main), { main, subagents: [] });
    mkdirSync(path.join(dir, 'sess-1', 'subagents'), { recursive: true });
    for (const n of ['agent-b.jsonl', 'agent-a.jsonl', 'note.txt']) writeFileSync(path.join(dir, 'sess-1', 'subagents', n), '');
    assert.deepEqual(sessionFiles(main).subagents, ['agent-a.jsonl', 'agent-b.jsonl'].map((n) => path.join(dir, 'sess-1', 'subagents', n)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
