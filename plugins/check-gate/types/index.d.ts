// `done`: finished while the run goes on, its outcome not known yet.
export type StepStatus = 'done' | 'ok' | 'failed' | 'running'

export type Step = { label: string; raw: string; status: StepStatus }

// `stale`: the code changed since the last result and nothing runs yet.
export type RunStatus = 'stale' | 'running' | 'passed' | 'failed' | 'error'

export type Run = {
  root: string
  repo: string
  command: string
  status: RunStatus
  trigger: 'auto' | 'commit' | 'manual'
  steps: Step[]
  // Fingerprint of the working tree the run checked.
  tree: string
  startedAt: number
  durationMs?: number
  exitCode?: number
  tail: string
  reason?: string
}

declare module 'claude-code' {
  interface PluginState {
    'check-gate': { runs: Shaped<Record<string, Run>> }
  }
}
