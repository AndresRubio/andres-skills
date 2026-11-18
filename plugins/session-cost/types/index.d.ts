/**
 * The engine's cost estimate as it gives it (its SessionCost): a contract
 * cannot import, so the shape is spelled here and checked against it by tsc.
 */
export type Cost = { usd: number; hasUnknownPrice?: true }

/** What the session has spent since the mod started counting. */
export type Totals = {
  /** Uncached input tokens. */
  input: number
  /** Generated tokens. */
  output: number
  /** Input tokens served from the prompt cache. */
  cacheRead: number
  /** Input tokens written to the prompt cache. */
  cacheWrite: number
  /** Model responses counted, subagents included. */
  calls: number
  /** All tokens of the latest response. */
  lastCall: number
  /** The engine's estimated cost of the session, when it has one. */
  cost?: Cost
}

declare module 'claude-code' {
  interface PluginState {
    'session-cost': { totals: Totals }
  }
}
