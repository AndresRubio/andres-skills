// One stage-mark: the stage the run entered and when, in ms since the epoch.
export type StageMark = { stage: string; at: number }

export type PipelineEvent = { at: number; text: string }

export type Mode = 'interactive' | 'auto'

// `waiting`: the main turn ended mid-run, so the run waits for the user.
export type RunStatus = 'running' | 'waiting' | 'finished' | 'stopped'

export type Subagent = { id: string; description: string; startedAt: number }

// How the run will end once its lock is released, set by the comment it posted.
export type PendingOutcome = { status: 'finished' | 'stopped'; text: string }

export type PipelineRun = {
  id: string
  // What /ship was given: "#12", an issue or PR URL, or an idea. Empty when unknown.
  source: string
  isFix: boolean
  mode: Mode
  runDir?: string
  key?: string
  number?: string
  repo?: string
  branch?: string
  title?: string
  prUrl?: string
  startedAt: number
  marks: StageMark[]
  status: RunStatus
  endedAt?: number
  outcome?: string
  pendingOutcome?: PendingOutcome
  // The kind of the last `pipeline.mjs marker <kind>` line, until a comment posts it.
  pendingMarker?: string
  // vars.sh was read once, so its absence later means the run folder is gone.
  hasVars: boolean
  subagents: Subagent[]
  // Newest last, at most five.
  events: PipelineEvent[]
}

declare module 'claude-code' {
  interface PluginState {
    'pipeline-pane': {
      active: Shaped<PipelineRun | null>
      history: Shaped<PipelineRun[]>
      now: number
    }
  }
}
