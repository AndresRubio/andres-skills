// What claude-pipeline's /ship emits, and how it maps to a run's state. Every name here comes
// from the plugin's own source: skills/ship/SKILL.md (Setup, the Stages table), stages/*.md,
// trackers/github.md, templates/progress.md, scripts/lib/run-record.mjs (stage-mark and
// stages.jsonl), marker.mjs (comment kinds) and session.mjs (how a run folder is spelled).

import type { Mode, PendingOutcome, PipelineEvent, PipelineRun, RunStatus, StageMark, Subagent } from '../types'

// The command and skill that start a run.
export const SHIP_COMMAND = 'claude-pipeline:ship'

// templates/progress.md's stage list; `fix` is fix mode's own mark (run-record.mjs STAGE_POLICY).
export const STAGE_NAMES: Readonly<Record<string, string>> = {
  '0': 'Resolve and lock',
  '1': 'Isolate',
  '2': 'Research',
  '3': 'Grade',
  '4': 'Spec',
  '5': 'Plan',
  '6': 'Build',
  '7': 'Verify',
  '8': 'Self-review',
  '9': 'Finish',
  '10': 'Report',
  fix: 'Fix',
}
export const SHIP_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as const
// fix.md: the inline steps are marked `fix`, then stage 7 and stage 8 get their own marks.
export const FIX_ORDER = ['fix', '7', '8'] as const

// marker.mjs MARKER_KINDS: the first line of every pipeline comment.
export const MARKER_KINDS = [
  'lock',
  'grade',
  'questions',
  'assumptions',
  'split',
  'report',
  'blocked',
  'reminder',
  'stale-lock',
  'deferred',
  'verdict',
  'ready',
  'score',
] as const

// README: the labels a target repo carries. `claude-working` is the run's lock.
export const LOCK_LABEL = 'claude-working'

const MAX_EVENTS = 5
export const MAX_RUNS = 5
// A start signal this soon after a run started with no stage yet is the same invocation
// (the slash command, then its skill prompt, then Setup).
const FRESH_MS = 5 * 60_000
// stage-mark seen as a tool call and again in stages.jsonl.
const SAME_MARK_MS = 60_000

// --- shell text ---

// Splits a command on &&, ||, ;, | and newlines outside quotes.
export function splitSegments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote !== null) {
      cur += c
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[++i]
      continue
    }
    const isAnd = c === '&' && command[i + 1] === '&'
    if (c === ';' || c === '\n' || c === '|' || isAnd) {
      out.push(cur)
      cur = ''
      if ((c === '&' || c === '|') && command[i + 1] === c) i++
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(s => s !== '')
}

// The words of one segment, quotes removed. Good enough for the pipeline's own commands.
export function words(segment: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let isWord = false
  for (const c of segment) {
    if (quote !== null) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      isWord = true
      continue
    }
    if (/\s/.test(c)) {
      if (isWord || cur !== '') out.push(cur)
      cur = ''
      isWord = false
      continue
    }
    cur += c
  }
  if (isWord || cur !== '') out.push(cur)
  return out
}

// Setup step 1 of SKILL.md: the command that makes the run folder names mktemp's template.
export function isSetupCommand(command: string): boolean {
  return command.includes('/runs/run-XXXXXX') && /\bmktemp\b/.test(command)
}

const SOURCED_VARS = /(?:^|[\s;&|(])(?:\.|source)\s+["']?([^"'\s]*\/runs\/run-[A-Za-z0-9]+)\/vars\.sh/
const RUN_DIR_FLAG = /--run-dir(?:\s+|=)["']?([^"'\s]*\/runs\/run-[A-Za-z0-9]+)\/?["']?(?:\s|$)/

// The run folder a command works in: the vars.sh it sources (every pipeline command after
// Setup starts `. '<RUN_DIR>/vars.sh' &&`), or a literal --run-dir. A command that only
// mentions the folder (ls, cat) does not count.
export function runDirFromCommand(command: string): string | undefined {
  const found = SOURCED_VARS.exec(command)?.[1] ?? RUN_DIR_FLAG.exec(command)?.[1]
  return found !== undefined && found.startsWith('/') ? found : undefined
}

// Setup ends with `echo "$RUN_DIR"`: the folder is the last line of its output.
export function runDirFromOutput(output: string): string | undefined {
  const lines = output.split('\n').map(line => line.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\/.*\/runs\/run-[A-Za-z0-9]+)\/?$/.exec(lines[i] as string)
    if (m) return m[1]
  }
  return undefined
}

export type Target = { on: 'issue' | 'pr'; ref: string }

export type BashSignal =
  | { kind: 'stage'; stage: string }
  | { kind: 'marker'; marker: string }
  | { kind: 'comment'; target: Target }
  | { kind: 'label'; action: 'add' | 'remove'; labels: string[]; target: Target }
  | { kind: 'pr-create' }
  | { kind: 'issue-create' }
  | { kind: 'push'; branch: string }
  | { kind: 'run-dir-removed' }

const isPipelineScript = (word: string | undefined) =>
  word !== undefined && (word === '$PIPELINE' || word === '${PIPELINE}' || word.endsWith('/pipeline.mjs'))

const isRunDirWord = (word: string | undefined) =>
  word !== undefined && (/^\$\{?RUN_DIR\}?\/?$/.test(word) || /^\/.*\/runs\/run-[A-Za-z0-9]+\/?$/.test(word))

const flagValue = (list: readonly string[], i: number, flag: string): string | undefined => {
  const word = list[i] as string
  if (word === flag) return list[i + 1]
  return word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : undefined
}

const labelList = (value: string) =>
  value
    .split(',')
    .map(label => label.trim())
    .filter(label => label !== '')

// What one Bash command does that the pane shows, in the order it does it.
export function bashSignals(command: string): BashSignal[] {
  const out: BashSignal[] = []
  for (const segment of splitSegments(command)) {
    const w = words(segment)
    const [program, sub, verb] = [w[0] ?? '', w[1], w[2]]

    // `node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage <n>` (SKILL.md, Stages).
    const markAt = w.indexOf('stage-mark')
    if (markAt > 0 && isPipelineScript(w[markAt - 1])) {
      for (let i = markAt + 1; i < w.length; i++) {
        const stage = flagValue(w, i, '--stage')
        if (stage !== undefined && Object.hasOwn(STAGE_NAMES, stage)) out.push({ kind: 'stage', stage })
      }
      continue
    }
    // `node "$PIPELINE" marker <kind> > "$RUN_DIR/comment.md"` (trackers/github.md, post-comment).
    const markerAt = w.indexOf('marker')
    if (markerAt > 0 && isPipelineScript(w[markerAt - 1])) {
      const kind = w[markerAt + 1]
      if (kind !== undefined && (MARKER_KINDS as readonly string[]).includes(kind)) out.push({ kind: 'marker', marker: kind })
      continue
    }
    if (program === 'gh' || program.endsWith('/gh')) {
      if ((sub === 'issue' || sub === 'pr') && verb === 'comment' && w[3] !== undefined && !w[3].startsWith('-')) {
        out.push({ kind: 'comment', target: { on: sub, ref: w[3] } })
      } else if ((sub === 'issue' || sub === 'pr') && verb === 'edit' && w[3] !== undefined) {
        const target: Target = { on: sub, ref: w[3] }
        for (let i = 4; i < w.length; i++) {
          const added = flagValue(w, i, '--add-label')
          const removed = flagValue(w, i, '--remove-label')
          if (added !== undefined) out.push({ kind: 'label', action: 'add', labels: labelList(added), target })
          if (removed !== undefined) out.push({ kind: 'label', action: 'remove', labels: labelList(removed), target })
        }
      } else if (sub === 'pr' && verb === 'create') {
        out.push({ kind: 'pr-create' })
      } else if (sub === 'issue' && verb === 'create') {
        out.push({ kind: 'issue-create' })
      }
      continue
    }
    if (program === 'git' && sub === 'push') {
      const branch = w.slice(2).filter(word => !word.startsWith('-')).at(-1)
      if (branch !== undefined && branch !== 'origin') out.push({ kind: 'push', branch })
      continue
    }
    // Stage 10 step 5 and the grade's wait: `rm -rf "$RUN_DIR"`.
    if (program === 'rm' && w.some(word => /^-[a-zA-Z]*r/i.test(word)) && isRunDirWord(w.at(-1))) {
      out.push({ kind: 'run-dir-removed' })
    }
  }
  return out
}

// A file the run writes under `docs/pipeline/<KEY>/` (every stage file names its output there).
export function pipelineFile(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined
  return /\/docs\/pipeline\/[^/]+\/(.+)$/.exec(path)?.[1]
}

// --- files the run keeps in its folder ---

// vars.sh holds `NAME='value'` lines (SKILL.md Setup step 2); a quote is written '\''.
export function parseVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const quoted = /^([A-Z_][A-Z0-9_]*)='((?:[^']|'\\'')*)'\s*$/.exec(line.trim())
    const bare = /^([A-Z_][A-Z0-9_]*)=([^\s'"]*)$/.exec(line.trim())
    if (quoted) vars[quoted[1] as string] = (quoted[2] as string).replace(/'\\''/g, "'")
    else if (bare) vars[bare[1] as string] = bare[2] as string
  }
  return vars
}

// stages.jsonl: one `{"stage","at","model","effort"}` per stage-mark. A torn line is no mark.
export function parseStageLines(text: string): StageMark[] {
  const marks: StageMark[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line) as { stage?: unknown; at?: unknown }
      const at = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.NaN
      if (typeof entry.stage === 'string' && Object.hasOwn(STAGE_NAMES, entry.stage) && Number.isFinite(at)) {
        marks.push({ stage: entry.stage, at })
      }
    } catch {
      // torn write
    }
  }
  return marks
}

// The issue's title from `$RUN_DIR/issue.json` (tracker:read-issue).
export function issueTitle(text: string): string | undefined {
  try {
    const issue = JSON.parse(text) as { title?: unknown }
    return typeof issue.title === 'string' && issue.title.trim() !== '' ? clip(issue.title.trim(), 80) : undefined
  } catch {
    return undefined
  }
}

// --- the slash command ---

export type ShipArgs = { source: string; mode: Mode; isFix: boolean }

// `/ship <source> [--mode auto|interactive] [--fix]` (SKILL.md, Arguments).
export function parseShipArgs(args: string): ShipArgs {
  let rest = ` ${args} `
  const isFix = /\s--fix(?=\s)/.test(rest)
  rest = rest.replace(/\s--fix(?=\s)/g, ' ')
  let mode: Mode = 'interactive'
  const m = /\s--mode(?:\s+|=)(auto|interactive)(?=\s)/.exec(rest)
  if (m) {
    mode = m[1] as Mode
    rest = rest.replace(m[0], ' ')
  }
  let source = rest.trim()
  if (source.length >= 2 && (source[0] === '"' || source[0] === "'") && source.endsWith(source[0])) {
    source = source.slice(1, -1).trim()
  }
  return { source, mode, isFix }
}

export function isShipSkill(skill: string, pluginName?: string, path?: string): boolean {
  if (skill === SHIP_COMMAND) return true
  const isShip = skill === 'ship' || skill.endsWith(':ship')
  const isOurs = pluginName === 'claude-pipeline' || /(^|\/)claude-pipeline\/(.*\/)?skills\/ship\/SKILL\.md$/.test(path ?? '')
  return isShip && isOurs
}

// --- words for the pane ---

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtAgo(ms: number): string {
  return ms < 5_000 ? 'just now' : `${fmtDuration(ms)} ago`
}

export function stageLabel(stage: string): string {
  const name = STAGE_NAMES[stage] ?? stage
  return stage === 'fix' ? name : `${stage} ${name}`
}

// "#12", "PR #31", a Linear id, or the idea in quotes.
export function sourceLabel(source: string, isFix: boolean): string {
  const s = source.trim()
  if (s === '') return isFix ? 'fix run' : 'run'
  const number = /^#?(\d+)$/.exec(s)
  if (number) return isFix ? `PR #${number[1]}` : `#${number[1]}`
  const url = /github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/(\d+)/.exec(s)
  if (url) return url[1] === 'pull' ? `PR #${url[2]}` : `#${url[2]}`
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(s)) return s
  return `"${clip(s, 60)}"`
}

export function runLabel(run: PipelineRun): string {
  if (!run.isFix && run.number !== undefined) return `#${run.number}`
  return sourceLabel(run.source, run.isFix)
}

export function isIdea(run: PipelineRun): boolean {
  return sourceLabel(run.source, run.isFix).startsWith('"')
}

const targetText = (target: Target, run: PipelineRun) => {
  const ref = target.ref.replace(/^#/, '')
  const number = /^\$\{?NUMBER\}?$/.test(ref) ? run.number : /^\d+$/.test(ref) ? ref : undefined
  if (number === undefined) return target.on === 'pr' ? 'the PR' : 'the issue'
  return target.on === 'pr' ? `PR #${number}` : `#${number}`
}

const prNumber = (url: string | undefined) => (url === undefined ? undefined : /\/pull\/(\d+)/.exec(url)?.[1])

// --- the run ---

export type Signal =
  | { kind: 'start'; via: 'command' | 'skill-tool' | 'skill-prompt' | 'setup' | 'vars'; args?: string; runDir?: string }
  | { kind: 'stage'; stage: string; at?: number }
  | { kind: 'vars'; vars: Readonly<Record<string, string>> }
  | { kind: 'title'; title: string }
  | { kind: 'bash'; signal: BashSignal; output?: string }
  | { kind: 'file'; tool: 'Write' | 'Edit'; file: string }
  | { kind: 'skill'; skill: string }
  | { kind: 'run-dir-gone' }
  | { kind: 'turn-start' }
  | { kind: 'turn-end'; isAborted: boolean }
  | { kind: 'agent-start'; id: string; description: string }
  | { kind: 'agent-end'; id: string }
  | { kind: 'session-end'; reason: string }

// The signals one successful Bash call gives, its output read for what it printed.
export function bashToSignals(input: { command: string; output: string }): Signal[] {
  const out: Signal[] = []
  if (isSetupCommand(input.command)) {
    const runDir = runDirFromOutput(input.output)
    out.push(runDir === undefined ? { kind: 'start', via: 'setup' } : { kind: 'start', via: 'setup', runDir })
  } else {
    const runDir = runDirFromCommand(input.command)
    if (runDir !== undefined) out.push({ kind: 'start', via: 'vars', runDir })
  }
  for (const signal of bashSignals(input.command)) out.push({ kind: 'bash', signal, output: input.output })
  return out
}

export function isOpen(run: PipelineRun | null | undefined): run is PipelineRun {
  return run !== null && run !== undefined && (run.status === 'running' || run.status === 'waiting')
}

export function currentStage(run: PipelineRun): string | undefined {
  return run.marks.at(-1)?.stage
}

const withEvent = (run: PipelineRun, text: string, at: number): PipelineRun => ({
  ...run,
  events: [...run.events, { at, text }].slice(-MAX_EVENTS),
})

// How a comment of this kind ends the run, if it does (stages 3, 10, fix.md and the stop procedure).
export function outcomeFor(kind: string | undefined, run: PipelineRun): PendingOutcome | undefined {
  const stage = currentStage(run)
  switch (kind) {
    case 'report': {
      if (run.isFix || stage === 'fix') return { status: 'finished', text: 'fix run finished' }
      if (stage === '10') return { status: 'finished', text: finishedText(run) }
      return { status: 'stopped', text: 'you ended the run' }
    }
    case 'blocked':
      return { status: 'stopped', text: 'blocked: needs a decision' }
    case 'questions':
      return { status: 'stopped', text: 'questions posted on the issue' }
    case 'split':
      return { status: 'stopped', text: 'split into sub-issues' }
    case 'deferred':
      return { status: 'stopped', text: 'deferred: other runs come first' }
    default:
      return undefined
  }
}

const finishedText = (run: PipelineRun) => {
  const pr = prNumber(run.prUrl)
  return pr === undefined ? 'report posted' : `PR #${pr} opened`
}

// Where a run that ends with no comment telling why stands.
const endWithoutComment = (run: PipelineRun, why: string): PendingOutcome =>
  currentStage(run) === '10'
    ? { status: 'finished', text: finishedText(run) }
    : { status: 'stopped', text: why }

function finish(run: PipelineRun, outcome: PendingOutcome, now: number): PipelineRun {
  const { pendingOutcome: _o, pendingMarker: _m, ...rest } = run
  return withEvent({ ...rest, status: outcome.status, outcome: outcome.text, endedAt: now, subagents: [] }, outcome.text, now)
}

function newRun(signal: Extract<Signal, { kind: 'start' }>, now: number): PipelineRun {
  const args = parseShipArgs(signal.args ?? '')
  const run: PipelineRun = {
    id: `run-${now}`,
    source: args.source,
    isFix: args.isFix,
    mode: args.mode,
    startedAt: now,
    marks: [],
    status: 'running',
    hasVars: false,
    subagents: [],
    events: [],
  }
  const text = signal.args === undefined ? 'run started' : `started ${SHIP_COMMAND}${signal.args.trim() ? ` ${clip(signal.args, 60)}` : ''}`
  return withEvent(signal.runDir === undefined ? run : { ...run, runDir: signal.runDir }, text, now)
}

// A second signal of the same invocation fills in what the first one lacked.
function mergeStart(run: PipelineRun, signal: Extract<Signal, { kind: 'start' }>): PipelineRun {
  let next = run
  if (signal.args !== undefined) {
    const args = parseShipArgs(signal.args)
    next = { ...next, source: next.source || args.source, mode: args.mode, isFix: args.isFix || next.isFix }
  }
  if (signal.runDir !== undefined && signal.runDir !== next.runDir) next = { ...next, runDir: signal.runDir, hasVars: false }
  return next
}

export type World = { run: PipelineRun | null; closedRunDirs: readonly string[] }

export type Step = {
  run: PipelineRun | null
  // Runs that ended in this step, a replaced one included.
  closed: PipelineRun[]
  started: boolean
  // A stage changed or the run started or ended: worth keeping in the store.
  isMilestone: boolean
}

// Applies signals in order. Returns the same run object when nothing changed.
export function reduce(world: World, signals: readonly Signal[], now: number): Step {
  let run = world.run
  const closed: PipelineRun[] = []
  let started = false
  let isMilestone = false

  const close = (outcome: PendingOutcome) => {
    if (!isOpen(run)) return
    closed.push(finish(run, outcome, now))
    run = null
    isMilestone = true
  }

  for (const signal of signals) {
    if (signal.kind === 'start') {
      if (signal.runDir !== undefined && world.closedRunDirs.includes(signal.runDir)) continue
      if (isOpen(run)) {
        if (signal.runDir !== undefined && run.runDir === signal.runDir) continue
        const isFresh = run.marks.length === 0 && now - run.startedAt < FRESH_MS
        if (isFresh) {
          const merged = mergeStart(run, signal)
          if (merged !== run) isMilestone = true
          run = merged
          continue
        }
        // Only the person's /ship (or the model's Skill call) starts a new run over an open one.
        // Setup again with no new /ship is the same run rebuilding its folder (SKILL.md Setup step 2).
        if (signal.via !== 'command' && signal.via !== 'skill-tool') {
          if (signal.runDir !== undefined) {
            run = withEvent({ ...run, runDir: signal.runDir, hasVars: false }, 'run folder made again', now)
            isMilestone = true
          }
          continue
        }
        close({ status: 'stopped', text: run.status === 'waiting' ? 'left waiting; a new run started' : 'a new run started' })
      }
      run = newRun(signal, now)
      started = true
      isMilestone = true
      continue
    }

    if (!isOpen(run)) continue
    const current: PipelineRun = run

    switch (signal.kind) {
      case 'stage': {
        run = withMark(current, signal.stage, signal.at ?? now)
        if (run !== current) isMilestone = true
        break
      }
      case 'vars': {
        const v = signal.vars
        const pick = (value: string | undefined, old: string | undefined) => (value !== undefined && value !== '' ? value : old)
        const mode: Mode = v.MODE === 'auto' || v.MODE === 'interactive' ? v.MODE : current.mode
        const next: PipelineRun = { ...current, hasVars: true, mode }
        const key = pick(v.KEY, current.key)
        const number = pick(v.NUMBER, current.number)
        const repo = pick(v.REPO, current.repo)
        const branch = pick(v.BRANCH, current.branch)
        if (key !== undefined) next.key = key
        if (number !== undefined) next.number = number
        if (repo !== undefined) next.repo = repo
        if (branch !== undefined) next.branch = branch
        const isSame =
          current.hasVars && next.key === current.key && next.number === current.number && next.repo === current.repo &&
          next.branch === current.branch && next.mode === current.mode
        if (!isSame) run = next
        break
      }
      case 'title':
        if (current.title === undefined) run = { ...current, title: clip(signal.title, 80) }
        break
      case 'file':
        // progress.md's ticks follow the stage marks the pane already shows.
        if (signal.tool === 'Edit' && signal.file === 'progress.md') break
        run = withEvent(current, `${signal.tool === 'Write' ? 'wrote' : 'edited'} ${signal.file}`, now)
        break
      case 'skill':
        run = withEvent(current, `skill ${signal.skill}`, now)
        break
      case 'bash': {
        const done = applyBash(current, signal.signal, signal.output ?? '', now)
        if ('close' in done) {
          close(done.close)
        } else {
          if (done.run.marks !== current.marks) isMilestone = true
          run = done.run
        }
        break
      }
      case 'run-dir-gone':
        close(current.pendingOutcome ?? endWithoutComment(current, 'run folder removed'))
        break
      case 'turn-start':
        if (current.status === 'waiting') run = { ...current, status: 'running' }
        break
      case 'turn-end': {
        if (current.pendingOutcome !== undefined) {
          close(current.pendingOutcome)
          break
        }
        // An automatic run never asks the user anything: its main turn ending ends the run.
        if (current.mode === 'auto') {
          close(endWithoutComment(current, 'the run ended without a report'))
          break
        }
        const waiting: PipelineRun = { ...current, status: 'waiting' }
        run = signal.isAborted ? withEvent(waiting, 'interrupted', now) : waiting
        break
      }
      case 'agent-start': {
        const agent: Subagent = { id: signal.id, description: clip(signal.description, 60), startedAt: now }
        run = withEvent({ ...current, subagents: [...current.subagents, agent] }, `subagent started: ${agent.description}`, now)
        break
      }
      case 'agent-end': {
        const agent = current.subagents.find(one => one.id === signal.id)
        if (agent === undefined) break
        const subagents = current.subagents.filter(one => one.id !== signal.id)
        run = withEvent(
          { ...current, subagents },
          `subagent finished: ${agent.description} (${fmtDuration(now - agent.startedAt)})`,
          now,
        )
        break
      }
      case 'session-end': {
        const resume = current.key === undefined ? '' : `; /${SHIP_COMMAND} ${current.key} resumes it`
        const why = signal.reason === 'clear' ? `session cleared${resume}` : `session ended${resume}`
        close(current.pendingOutcome ?? endWithoutComment(current, why))
        break
      }
    }
  }
  return { run, closed, started, isMilestone }
}

// A stage-mark seen twice (the tool call, then stages.jsonl) is one mark.
function withMark(run: PipelineRun, stage: string, at: number): PipelineRun {
  if (run.marks.some(m => m.stage === stage && Math.abs(m.at - at) <= SAME_MARK_MS)) return run
  return {
    ...run,
    marks: [...run.marks, { stage, at }].sort((a, b) => a.at - b.at),
    startedAt: Math.min(run.startedAt, at),
    isFix: run.isFix || stage === 'fix',
    status: 'running',
  }
}

type BashResult = { run: PipelineRun } | { close: PendingOutcome }

function applyBash(run: PipelineRun, signal: BashSignal, output: string, now: number): BashResult {
  switch (signal.kind) {
    case 'stage':
      return { run: withMark(run, signal.stage, now) }
    case 'marker':
      return { run: { ...run, pendingMarker: signal.marker } }
    case 'comment': {
      const kind = run.pendingMarker
      const { pendingMarker: _m, ...rest } = run
      const outcome = outcomeFor(kind, run)
      const posted = withEvent(rest, `posted ${kind === undefined ? 'a' : `the ${kind}`} comment on ${targetText(signal.target, run)}`, now)
      return { run: outcome === undefined ? posted : { ...posted, pendingOutcome: outcome } }
    }
    case 'label': {
      // Releasing the lock is the last step of every way a run ends (stage 10, the stop
      // procedure, a split, a wait, a deferral).
      if (signal.action === 'remove' && signal.target.on === 'issue' && signal.labels.includes(LOCK_LABEL)) {
        const outcome = run.pendingOutcome ?? (currentStage(run) === '10' ? endWithoutComment(run, '') : undefined)
        if (outcome !== undefined) return { close: outcome }
      }
      const verb = signal.action === 'add' ? 'added' : 'removed'
      const where = signal.action === 'add' ? 'to' : 'from'
      return { run: withEvent(run, `${verb} label ${signal.labels.join(', ')} ${where} ${targetText(signal.target, run)}`, now) }
    }
    case 'pr-create': {
      const url = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/.exec(output)?.[0]
      const opened = url === undefined ? run : { ...run, prUrl: url }
      return { run: withEvent(opened, url === undefined ? 'opened the pull request' : `opened PR #${prNumber(url)}`, now) }
    }
    case 'issue-create': {
      const number = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)/.exec(output)?.[1]
      return { run: withEvent(run, number === undefined ? 'created an issue' : `created issue #${number}`, now) }
    }
    case 'push': {
      const branch = /^\$\{?BRANCH\}?$/.test(signal.branch) ? (run.branch ?? 'the branch') : signal.branch
      return { run: withEvent(run, `pushed ${branch}`, now) }
    }
    case 'run-dir-removed':
      return { close: run.pendingOutcome ?? endWithoutComment(run, 'run folder removed') }
  }
}

// --- what the pane and the command show ---

export type StageRow = { stage: string; label: string; ms: number }

export function stageRows(run: PipelineRun, now: number): { done: StageRow[]; current: StageRow | null; next: string[] } {
  const end = run.endedAt ?? now
  const rows = run.marks.map((mark, i) => ({
    stage: mark.stage,
    label: stageLabel(mark.stage),
    ms: Math.max(0, (run.marks[i + 1]?.at ?? end) - mark.at),
  }))
  if (!isOpen(run)) return { done: rows, current: null, next: [] }
  const current = rows.pop() ?? null
  const order: readonly string[] = run.isFix ? FIX_ORDER : SHIP_ORDER
  const at = current === null ? -1 : order.indexOf(current.stage)
  const next = current !== null && at < 0 ? [] : order.slice(at + 1).map(stage => STAGE_NAMES[stage] ?? stage)
  return { done: rows, current, next }
}

export function statusLine(run: PipelineRun, now: number): string {
  const total = fmtDuration((run.endedAt ?? now) - run.startedAt)
  const stage = currentStage(run)
  switch (run.status) {
    case 'running':
      return `Running for ${total}`
    case 'waiting':
      return `Waiting for you · ${total} so far`
    case 'finished':
      return `Finished in ${total} · ${run.outcome ?? 'done'}`
    case 'stopped':
      return `Stopped${stage === undefined ? '' : ` at ${STAGE_NAMES[stage]}`} after ${total} · ${run.outcome ?? 'stopped'}`
  }
}

export function endToast(run: PipelineRun): string {
  const total = fmtDuration((run.endedAt ?? run.startedAt) - run.startedAt)
  const stage = currentStage(run)
  if (run.status === 'finished') return `Pipeline ${runLabel(run)} finished in ${total}: ${run.outcome ?? 'done'}.`
  const at = stage === undefined ? '' : ` at ${STAGE_NAMES[stage]}`
  return `Pipeline ${runLabel(run)} stopped${at} after ${total}: ${run.outcome ?? 'stopped'}.`
}

export function heading(run: PipelineRun): string {
  const label = runLabel(run)
  if (run.title !== undefined) return `${label} ${run.title}`
  if (isIdea(run) && !label.startsWith('"')) return `${label} ${sourceLabel(run.source, false)}`
  return isIdea(run) ? `Idea: ${label}` : label
}

export function detailLine(run: PipelineRun): string {
  const parts = [run.repo, run.branch, run.isFix ? 'fix' : undefined, run.mode === 'auto' ? 'auto' : 'interactive']
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ')
}

// The text /pipeline-pane prints, for surfaces with no pane and for the model.
export function summaryText(run: PipelineRun, now: number): string {
  const rows = stageRows(run, now)
  const lines = [`Pipeline ${heading(run)}: ${statusLine(run, now)}.`]
  if (rows.current !== null) lines.push(`Now: ${rows.current.label}, ${fmtDuration(rows.current.ms)}.`)
  if (rows.done.length > 0) lines.push(`Done: ${rows.done.map(row => `${row.label} ${fmtDuration(row.ms)}`).join(', ')}.`)
  if (run.subagents.length > 0) lines.push(`Subagents running: ${run.subagents.map(agent => agent.description).join(', ')}.`)
  const last = run.events.at(-1)
  if (last !== undefined) lines.push(`Last: ${last.text}, ${fmtAgo(now - last.at)}.`)
  return lines.join('\n')
}

export function lastEvents(run: PipelineRun, count: number): PipelineEvent[] {
  return run.events.slice(-count).reverse()
}

// --- the store ---

const STATUSES: readonly RunStatus[] = ['running', 'waiting', 'finished', 'stopped']

const isMark = (value: unknown): value is StageMark =>
  typeof value === 'object' && value !== null &&
  typeof (value as StageMark).stage === 'string' && typeof (value as StageMark).at === 'number'

// A run as this version writes it; anything else in the store is dropped.
export function isRun(value: unknown): value is PipelineRun {
  if (typeof value !== 'object' || value === null) return false
  const run = value as Partial<PipelineRun>
  return (
    typeof run.id === 'string' && typeof run.source === 'string' && typeof run.isFix === 'boolean' &&
    (run.mode === 'interactive' || run.mode === 'auto') && typeof run.startedAt === 'number' &&
    Array.isArray(run.marks) && run.marks.every(isMark) && STATUSES.includes(run.status as RunStatus) &&
    typeof run.hasVars === 'boolean' && Array.isArray(run.subagents) && Array.isArray(run.events) &&
    run.events.every(event => typeof event?.text === 'string' && typeof event.at === 'number')
  )
}

export function toRuns(value: unknown): PipelineRun[] {
  return Array.isArray(value) ? value.filter(isRun).slice(0, MAX_RUNS) : []
}

// Newest first, one entry per run.
export function pushHistory(list: readonly PipelineRun[], run: PipelineRun): PipelineRun[] {
  return [run, ...list.filter(one => one.id !== run.id)].slice(0, MAX_RUNS)
}

export function newestFirst(runs: readonly PipelineRun[]): PipelineRun[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS)
}

export function lastActivity(run: PipelineRun): number {
  return Math.max(run.startedAt, run.endedAt ?? 0, run.marks.at(-1)?.at ?? 0, run.events.at(-1)?.at ?? 0)
}

// The store is shared by every session. For a run both hold, the copy that saw something
// later wins, and on a tie the stored one: another window may still be running it.
export function mergeStored(mine: readonly PipelineRun[], stored: readonly PipelineRun[]): PipelineRun[] {
  const byId = new Map<string, PipelineRun>()
  for (const run of stored) byId.set(run.id, run)
  for (const run of mine) {
    const old = byId.get(run.id)
    if (old === undefined || lastActivity(run) > lastActivity(old)) byId.set(run.id, run)
  }
  return newestFirst([...byId.values()])
}

// A stored run still marked open is not followed by this session: its session ended, or it
// runs in another window. It shows as ended here, at the last thing it saw.
export function endedWithSession(run: PipelineRun): PipelineRun {
  if (!isOpen(run)) return run
  return finish(run, { status: 'stopped', text: 'the session ended before the run did' }, lastActivity(run))
}
