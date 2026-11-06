// What forja printed as its cost line, or what the mod worked out from the
// config and forja's Modal price table.
export type Quote = {
  provider: string
  gpu: string
  hourlyUsd: number
  worstUsd: number
  maxHours: number
  note: string
  source: 'forja' | 'table'
}

// A forja run the mod follows from the Bash call that started it until it ends.
export type TrackedRun = {
  id: string
  // The config as the command wrote it, for display.
  config: string
  configPath?: string
  // The config and its --set overrides: where forja's quote is remembered.
  quoteKey?: string
  // Folder the command runs in.
  cwd: string
  project?: string
  provider?: string
  gpu?: string
  hourlyUsd?: number
  worstUsd?: number
  maxHours?: number
  // Where forja writes run folders, and the ones that existed before the call.
  runsDir?: string
  known: string[]
  runDir?: string
  // The background task's output file, once the Bash tool moved the run there.
  outputPath?: string
  // When forja created the run folder: the start of forja's own cost clock.
  startedAt?: number
  // state.json's status.
  status?: string
}

// Remote resources that may still exist, one per provider ('unknown' when
// the provider could not be told).
export type Reminder = {
  key: string
  provider?: string
  why: string
  since: number
  config?: string
}

export type CachedQuote = { quote: Quote; at: number }

declare module 'claude-code' {
  interface PluginState {
    'forja-cost-guard': {
      runs: Shaped<Record<string, TrackedRun>>
      reminders: Shaped<Record<string, Reminder>>
      quotes: Shaped<Record<string, CachedQuote>>
      tick: number
    }
  }
}
