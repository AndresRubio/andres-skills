// One real headless session (Task 6 of the Phase 2b plan), captured on 2026-10-29 with Claude Code 2.1.284.
// Subagent usage lives in: subagents/*.jsonl (isSidechain true there; main.jsonl has no sidechain entries).
// One message on several lines (same message.id): yes, and an early line can carry a partial output_tokens, so the last line per id is the one to count (then the sums equal modelUsage).
// usage.cache_creation splits ephemeral_5m/ephemeral_1h: yes (and the result usage covers the final turn only; modelUsage covers the tree).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./fixtures/usage/', import.meta.url);
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the usage fixture is a matched -p result and transcript with a subagent', () => {
  const result = JSON.parse(readFileSync(new URL('result.json', dir), 'utf8'));
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) assert.equal(typeof result.usage[k], 'number', k);
  assert.equal(typeof result.total_cost_usd, 'number');
  assert.ok(Object.keys(result.modelUsage).length >= 2, 'the session and its haiku subagent each report a model');
  const main = lines(new URL('main.jsonl', dir));
  assert.ok(main.every((e) => e.sessionId === result.session_id));
  assert.ok(main.some((e) => e.type === 'assistant' && e.message?.usage));
  const subDir = new URL('subagents/', dir);
  const subFiles = existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith('.jsonl')) : [];
  assert.ok(main.some((e) => e.isSidechain === true) || subFiles.length > 0, 'subagent usage is somewhere');
});

import { tokensFromResult, usageFromTranscripts, readJsonl } from '../skills/ship/scripts/lib/usage.mjs';
import { fileURLToPath } from 'node:url';

test('the transcript sum equals the -p result, and the price table explains total_cost_usd', () => {
  const result = JSON.parse(readFileSync(new URL('result.json', dir), 'utf8'));
  const subDir = new URL('subagents/', dir);
  const subagents = existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => readJsonl(fileURLToPath(new URL(f, subDir)))) : [];
  const fromTranscript = usageFromTranscripts([{ main: readJsonl(fileURLToPath(new URL('main.jsonl', dir))), subagents }]);
  const fromResult = tokensFromResult(result);
  const { subagents: fromTranscriptSubagents, ...transcriptTokens } = fromTranscript.tokens;
  const { subagents: fromResultSubagents, ...resultTokens } = fromResult.tokens;
  assert.deepEqual(transcriptTokens, resultTokens);
  // result.usage covers the final turn only, so the result cannot give the subagent share; the haiku subagent's own modelUsage row can.
  assert.equal(fromResultSubagents, null);
  const h = result.modelUsage['claude-haiku-4-5-20251001'];
  assert.equal(fromTranscriptSubagents, h.inputTokens + h.outputTokens + h.cacheReadInputTokens + h.cacheCreationInputTokens);
  assert.deepEqual(fromTranscript.unpriced, [], `add these models to prices.mjs: ${fromTranscript.unpriced.join(', ')}`);
  // (a) The deduplicated per-model tokens of this fixture, priced by hand at the table's rates (USD per million).
  // sonnet 5.5: in 6, out 366, cache read 109383, 1h write 23688. haiku 4.5: in 18, out 456, cache read 23785, 5m write 25803.
  const sonnetUsd = (6 * 2 + 366 * 10 + 109383 * 0.1 + 23688 * 4) / 1e6;
  const haikuUsd = (18 * 1 + 456 * 5 + 23785 * 0.1 + 25803 * 1.25) / 1e6;
  assert.ok(Math.abs(fromTranscript.usd - (sonnetUsd + haikuUsd)) <= 1e-6, `estimated ${fromTranscript.usd}, by hand ${sonnetUsd + haikuUsd}`);
  // (b) Claude Code's total_cost_usd is its own estimate and still bills Sonnet 5.5 cache reads at 0.20; the page says 0.10.
  // The gap is that difference alone. If this breaks, Claude Code's table or the pricing page changed: re-read both.
  const lastPerId = new Map();
  for (const e of readJsonl(fileURLToPath(new URL('main.jsonl', dir)))) if (e.type === 'assistant' && e.message?.usage) lastPerId.set(e.message.id, e.message);
  const sonnetCacheReadTokens = [...lastPerId.values()].filter((m) => m.model === 'claude-sonnet-5-5').reduce((n, m) => n + m.usage.cache_read_input_tokens, 0);
  assert.equal(sonnetCacheReadTokens, 109383);
  const adjusted = fromTranscript.usd + (sonnetCacheReadTokens * (0.20 - 0.10)) / 1e6;
  assert.ok(Math.abs(adjusted - result.total_cost_usd) <= 0.01 * result.total_cost_usd, `adjusted ${adjusted}, actual ${result.total_cost_usd}`);
});
