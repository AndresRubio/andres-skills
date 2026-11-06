import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PipelineRun, RunStatus } from '../types'
import {
  SHIP_COMMAND,
  bashSignals,
  bashToSignals,
  detailLine,
  endToast,
  endedWithSession,
  fmtAgo,
  fmtDuration,
  heading,
  isOpen,
  isSetupCommand,
  isShipSkill,
  issueTitle,
  lastEvents,
  mergeStored,
  newestFirst,
  parseStageLines,
  parseVars,
  pipelineFile,
  pushHistory,
  reduce,
  runDirFromCommand,
  runLabel,
  stageRows,
  statusLine,
  summaryText,
  toRuns,
} from './logic'
import type { Signal, Step } from './logic'

type Engine = EngineInterface

const PANE = 'pipeline-pane'
const TITLE = 'Pipeline'
// The store key carries the shape tag: a run written by another version is not read.
const STORE_KEY = 'runs-1'
// Change a tag when PipelineRun's fields change: it declines what an earlier version stored.
const active = atom({ plugin: 'pipeline-pane', key: 'active' } as const, null, { shape: 'run-1' })
const history = atom({ plugin: 'pipeline-pane', key: 'history' } as const, [], { shape: 'history-1' })
// The time the pane last ticked, so elapsed times redraw while a run goes.
const clock = atom({ plugin: 'pipeline-pane', key: 'now' } as const, 0)

const TICK_MS = 1_000
// The run folder's files are read every fifth tick.
const POLL_EVERY = 5
const TITLE_TRIES = 20

const COLOR: Record<RunStatus, 'text' | 'warning' | 'success' | 'error'> = {
  running: 'text',
  waiting: 'warning',
  finished: 'success',
  stopped: 'error',
}

// What the hooks need to know without a $ call: whether a run is open, and its folder.
// Set where `active` is written; a reload starts it over and session.start reads it back.
let live: { status: RunStatus; runDir?: string } | undefined
let ticker: { cancel: () => void } | undefined
let ticks = 0
let isPolling = false
const titleTries = new Map<string, number>()

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// State and the store take JSON: this drops undefined fields.
const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const mirror = (run: PipelineRun | null) => {
  live = isOpen(run) ? { status: run.status, ...(run.runDir === undefined ? {} : { runDir: run.runDir }) } : undefined
}

// Observing never gets in a tool's or a turn's way: a failure goes to the debug log.
const safely = async ($: Engine, work: () => Promise<void>) => {
  try {
    await work()
  } catch (error) {
    $.ui.log(`pipeline-pane: ${errorText(error)}`, { to: 'debug' })
  }
}

// The store is shared by every session, so this merges with what is there (mergeStored).
const saveStore = async ($: Engine) => {
  const run = await read($, active)
  const mine = [...(run === null ? [] : [run]), ...(await read($, history)).filter(one => one.id !== run?.id)]
  await $.store.set(STORE_KEY, json(mergeStored(mine, toRuns(await $.store.get(STORE_KEY)))))
}

const openPane = ($: Engine) => $.ui.open({ id: PANE, title: TITLE })

const stopTicker = () => {
  ticker?.cancel()
  ticker = undefined
}

const ensureTicker = ($: Engine) => {
  if (ticker !== undefined) return
  ticks = 0
  ticker = $.clock.every(TICK_MS, () => {
    void tick($).catch(error => $.ui.log(`pipeline-pane: ${errorText(error)}`, { to: 'debug' }))
  })
}

const tick = async ($: Engine) => {
  if (live === undefined) {
    stopTicker()
    return
  }
  const now = await $.clock.now()
  await update($, clock, () => now)
  ticks += 1
  if (ticks % POLL_EVERY === 0 && !isPolling) {
    isPolling = true
    try {
      await poll($)
    } finally {
      isPolling = false
    }
  }
}

// Reads the run folder: vars.sh (KEY, NUMBER, REPO, BRANCH, MODE), stages.jsonl (every
// stage-mark, with its time) and issue.json (the title). A vars.sh that was there and is
// gone means the run removed its folder.
const poll = async ($: Engine) => {
  const run = await read($, active)
  if (!isOpen(run) || run.runDir === undefined) return
  const dir = run.runDir
  const signals: Signal[] = []

  const stages = await $.fs.read(`${dir}/stages.jsonl`).catch(() => undefined)
  for (const mark of typeof stages === 'string' ? parseStageLines(stages) : []) {
    signals.push({ kind: 'stage', stage: mark.stage, at: mark.at })
  }
  const vars = await $.fs.read(`${dir}/vars.sh`).catch(() => undefined)
  if (typeof vars === 'string') {
    signals.push({ kind: 'vars', vars: parseVars(vars) })
  } else if (run.hasVars && !(await $.fs.exists(`${dir}/vars.sh`).catch(() => true))) {
    signals.push({ kind: 'run-dir-gone' })
  }
  const tries = titleTries.get(run.id) ?? 0
  if (run.title === undefined && tries < TITLE_TRIES) {
    titleTries.set(run.id, tries + 1)
    const issue = await $.fs.read(`${dir}/issue.json`).catch(() => undefined)
    const title = typeof issue === 'string' ? issueTitle(issue) : undefined
    if (title !== undefined) signals.push({ kind: 'title', title })
  }
  await apply($, signals)
}

// Runs the signals through the reducer, then does what the step calls for.
const apply = async ($: Engine, signals: readonly Signal[]) => {
  if (signals.length === 0) return
  const now = await $.clock.now()
  const closedRunDirs = (await read($, history)).flatMap(run => (run.runDir === undefined ? [] : [run.runDir]))
  const before = await read($, active)
  const trial = reduce({ run: before, closedRunDirs }, signals, now)
  if (trial.run === before && trial.closed.length === 0) return

  let step: Step = trial
  await update($, active, run => {
    step = reduce({ run, closedRunDirs }, signals, now)
    mirror(step.run)
    return step.run === null ? null : json(step.run)
  })
  await afterStep($, step)
}

const afterStep = async ($: Engine, step: Step) => {
  for (const run of step.closed) {
    await update($, history, list => json(pushHistory(list, run)))
    $.ui.toast(endToast(run), { timeoutMs: 8_000 })
  }
  if (step.started) {
    void openPane($).catch(error => $.ui.log(`pipeline-pane: ${errorText(error)}`, { to: 'debug' }))
  }
  if (isOpen(step.run)) ensureTicker($)
  else stopTicker()
  if (step.isMilestone) await saveStore($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await safely($, async () => {
      await $.command.register({
        name: 'pipeline-pane',
        description: 'Show the claude-pipeline run in a pane: the stage now running, the finished stages and the last event',
      })
      // A reload keeps $.state: a run this session still runs stays open.
      const run = await read($, active)
      mirror(run)
      if (isOpen(run)) ensureTicker($)
      // A stored run still marked open is not followed here: its session ended (or it runs in
      // another window). It shows as ended in this session; the store keeps what was written.
      const stored = toRuns(await $.store.get(STORE_KEY)).filter(one => one.id !== run?.id)
      if (stored.length === 0) return
      const past = stored.map(endedWithSession)
      await update($, history, list => json(newestFirst([...past, ...list.filter(one => !past.some(p => p.id === one.id))])))
    })
    return started
  })

  // The person's /claude-pipeline:ship. Its arguments say what the run is for.
  on('command.run', { command: 'claude-pipeline:ship' }, async ($, e, next) => {
    await safely($, () => apply($, [{ kind: 'start', via: 'command', args: e.args }]))
    return next(e)
  }).catch(($, e, next) => next(e))

  // The model invoking the skill itself (a runner, or "ship issue 12").
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const input = e as { skill?: unknown; args?: unknown }
    if (input.skill === SHIP_COMMAND) {
      const args = typeof input.args === 'string' ? input.args : ''
      await safely($, () => apply($, [{ kind: 'start', via: 'skill-tool', args }]))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The ship skill's prompt, however it was invoked; any other skill used during a run.
  on('skill.prompt', async ($, e, next) => {
    if (isShipSkill(e.skill, e.pluginName, e.path)) {
      await safely($, () => apply($, [{ kind: 'start', via: 'skill-prompt' }]))
    } else if (live !== undefined) {
      await safely($, () => apply($, [{ kind: 'skill', skill: e.skill }]))
    }
    return next(e)
  })

  // Setup, stage-marks, comments, labels, the PR, pushes and removing the run folder.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    const runDir = runDirFromCommand(command)
    const isNewDir = runDir !== undefined && runDir !== live?.runDir
    const isWanted = isSetupCommand(command) || isNewDir || (live !== undefined && bashSignals(command).length > 0)
    if (!isWanted) return next(e)

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await safely($, () => apply($, bashToSignals({ command, output: ran.text ?? '' })))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Files the run writes under docs/pipeline/<KEY>/.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const file = live === undefined ? undefined : pipelineFile((e as { file_path?: unknown }).file_path)
    if (file === undefined) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await safely($, () => apply($, [{ kind: 'file', tool: 'Write', file }]))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const file = live === undefined ? undefined : pipelineFile((e as { file_path?: unknown }).file_path)
    if (file === undefined) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await safely($, () => apply($, [{ kind: 'file', tool: 'Edit', file }]))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A subagent starts: its id comes back from the spawn, its end is its turn.complete.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const id = (spawned as { agentId?: unknown }).agentId
    if (live !== undefined && typeof id === 'string') {
      await safely($, () => apply($, [{ kind: 'agent-start', id, description: e.description }]))
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && live?.status === 'waiting') {
      await safely($, () => apply($, [{ kind: 'turn-start' }]))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (live !== undefined) {
      const signal: Signal =
        e.agentId !== undefined ? { kind: 'agent-end', id: e.agentId } : { kind: 'turn-end', isAborted: e.isAborted }
      await safely($, () => apply($, [signal]))
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (live !== undefined) await safely($, () => apply($, [{ kind: 'session-end', reason: e.reason }]))
    return next(e)
  })

  on('command.run', { command: 'pipeline-pane' }, async $ => {
    await openPane($).catch(() => undefined)
    const run = (await read($, active)) ?? (await read($, history))[0]
    if (run === undefined) return { text: `No pipeline run yet. Start one with /${SHIP_COMMAND} #N.` }
    const now = await $.clock.now()
    return { text: `${isOpen(run) ? '' : 'Last run. '}${summaryText(run, now)}` }
  }).catch(() => ({ text: 'pipeline-pane: could not read the run. Try again.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, clock)
    const now = await $.clock.now()
    const run = await read($, active)
    const past = await read($, history)
    const shown = run ?? past[0]

    if (shown === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No pipeline run yet.</Text>
          <Text dimColor>Start one with /{SHIP_COMMAND} #N.</Text>
        </Box>
      )
    }

    const rows = stageRows(shown, now)
    const detail = detailLine(shown)
    const events = lastEvents(shown, 3)
    const earlier = past.filter(one => one.id !== shown.id).slice(0, 3)

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {heading(shown)}
        </Text>
        {detail !== '' && (
          <Text dimColor wrap="truncate-end">
            {detail}
          </Text>
        )}
        <Text color={COLOR[shown.status]}>{statusLine(shown, now)}</Text>

        {rows.current !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Now</Text>
            <Box justifyContent="space-between">
              <Text bold>▸ {rows.current.label}</Text>
              <Text>{fmtDuration(rows.current.ms)}</Text>
            </Box>
            {shown.subagents.map(agent => (
              <Text dimColor wrap="truncate-end">
                {'  '}subagent: {agent.description} ({fmtDuration(now - agent.startedAt)})
              </Text>
            ))}
          </Box>
        )}

        {rows.done.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Done</Text>
            {rows.done.map(row => (
              <Box justifyContent="space-between">
                <Text>✓ {row.label}</Text>
                <Text dimColor>
                  {fmtDuration(row.ms)}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {rows.next.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Next</Text>
            <Text dimColor wrap="wrap">
              {rows.next.join(', ')}
            </Text>
          </Box>
        )}

        {events.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Last event</Text>
            {events.map((event, i) => (
              <Text dimColor={i > 0} wrap="truncate-end">
                {event.text} · {fmtAgo(now - event.at)}
              </Text>
            ))}
          </Box>
        )}

        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Earlier runs</Text>
            {earlier.map(one => (
              <Text dimColor wrap="truncate-end">
                {runLabel(one)}: {one.status} after {fmtDuration((one.endedAt ?? one.startedAt) - one.startedAt)}
                {one.outcome === undefined ? '' : `, ${one.outcome}`}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
