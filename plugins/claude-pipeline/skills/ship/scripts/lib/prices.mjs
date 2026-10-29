// USD per million tokens, Anthropic first-party API rates. A null rate is unknown: a message that
// needs it is unpriced, which makes the run's usd null.
// Every rate: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-30.
// Sonnet 5.5 cacheRead is the exception, see the note on its row.
export const PRICES = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  // The pricing page lists 0.10 for Sonnet 5.5 cache hits (0.05x input). Claude Code's own
  // total_cost_usd for the Task 6 fixture only reproduces with 0.2, so 0.2 stays until that is settled.
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  // Haiku 5.5 bills prompts over 100K tokens at the long-context rates.
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2,
    longContext: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
});
