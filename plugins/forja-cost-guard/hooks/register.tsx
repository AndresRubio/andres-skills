import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Quote, Reminder, TrackedRun } from '../types'
import {
  BUILTIN_MODAL_PRICES,
  CLEANUP_PROMPT_NOTE,
  abortedNote,
  applySets,
  askText,
  asReminders,
  basename,
  cleanupClears,
  cleanupCommand,
  costUsd,
  dirname,
  findForja,
  formatUsd,
  isGuarded,
  isPromptAborted,
  isRunFolder,
  joinPath,
  judgeRun,
  leftoverNote,
  leftoverWhy,
  parseCleanup,
  parseCleanupArgs,
  parseExitMarker,
  parsePricing,
  parseQuote,
  parseRunArgs,
  parseRunFolder,
  parseState,
  parseYaml,
  planFor,
  readBashResult,
  refusedText,
  reminderLine,
  runLine,
  runsNeedingConfirmation,
  skippedNote,
} from './logic'
import type { CleanupArgs, ForjaRun, Invocation, Plan, PriceTable, RunState } from './logic'

type Engine = EngineInterface

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const runs = atom({ plugin: 'forja-cost-guard', key: 'runs' } as const, {}, { shape: 'runs-1' })
const reminders = atom({ plugin: 'forja-cost-guard', key: 'reminders' } as const, {}, { shape: 'reminders-1' })
const quotes = atom({ plugin: 'forja-cost-guard', key: 'quotes' } as const, {}, { shape: 'quotes-1' })
const tick = atom({ plugin: 'forja-cost-guard', key: 'tick' } as const, 0)

// Reminders outlive the session: leftovers keep billing after it ends.
const STORE_REMINDERS = 'reminders-1'
const POLL_MS = 5_000
const QUOTE_TTL_MS = 12 * 3_600_000
// $.fs.read refuses files over 4 MiB; a long RunPod log can pass that.
const MAX_READ = 4 * 1024 * 1024 - 1

let poller: Timer | undefined
let isPolling = false
// Runs whose Bash call is still open in this load of the module.
const pendingCalls = new Set<string>()
let home: string | undefined
let counter = 0

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const logDebug = ($: Engine, error: unknown) => $.ui.log(`forja-cost-guard: ${errorText(error)}`, { to: 'debug' })

const homeDir = async ($: Engine) => {
  if (home !== undefined) return home
  const found = await $.process.run(['/bin/sh', '-c', 'printf "%s" "$HOME"'])
  home = found.stdout.trim() || '/'
  return home
}

const expand = async ($: Engine, base: string, path: string) =>
  path === '~' || path.startsWith('~/') ? joinPath(await homeDir($), path.slice(2)) : joinPath(base, path)

// The folder a forja invocation runs in: the session's, then each `cd` before it.
const commandDir = async ($: Engine, invocation: Invocation) => {
  let dir = await $.session.cwd()
  for (const cd of invocation.cds) dir = await expand($, dir, cd)
  return dir
}

const repoRoot = async ($: Engine, dir: string) => {
  try {
    const found = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir })
    return found.exitCode === 0 ? found.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

// forja's own Modal prices when the command runs inside the forja repo,
// else the copy in logic.ts. Read each time, so an edited price shows at once.
const priceTable = async ($: Engine, dir: string): Promise<PriceTable> => {
  const root = await repoRoot($, dir)
  if (root === undefined) return BUILTIN_MODAL_PRICES
  try {
    const file = `${root}/src/forja/pricing.py`
    if (await $.fs.exists(file)) return parsePricing(await $.fs.read(file)) ?? BUILTIN_MODAL_PRICES
  } catch {
    // The copy stands.
  }
  return BUILTIN_MODAL_PRICES
}

const readConfig = async ($: Engine, path: string) => {
  try {
    return parseYaml(await $.fs.read(path))
  } catch {
    return undefined
  }
}

const listNames = async ($: Engine, dir: string) => {
  try {
    return (await $.fs.list(dir)).map(entry => entry.name)
  } catch {
    return []
  }
}

const readState = async ($: Engine, runDir: string): Promise<RunState | undefined> => {
  try {
    return parseState(await $.fs.read(`${runDir}/state.json`))
  } catch {
    return undefined
  }
}

// The background task's output: whole when it fits, else its head (the
// quote) and its tail (the end and the exit line).
const readOutput = async ($: Engine, path: string) => {
  try {
    const stat = await $.fs.stat(path)
    if (stat.size <= MAX_READ) return await $.fs.read(path)
    const head = await $.process.run(['/usr/bin/head', '-c', '32768', path])
    const tail = await $.process.run(['/usr/bin/tail', '-c', '65536', path])
    return `${head.stdout}\n${tail.stdout}`
  } catch {
    return undefined
  }
}

type Prepared = { plan: Plan; dir: string; configPath: string; runsDir: string; quoteKey: string }

// Reads the run's config and works out its cost, before anything runs.
const prepare = async ($: Engine, run: ForjaRun): Promise<Prepared> => {
  const dir = await commandDir($, run.invocation)
  const config = run.args.config ?? ''
  const configPath = await expand($, dir, config)
  const raw = await readConfig($, configPath)
  const quoteKey = [configPath, ...run.args.sets].join('\n')
  const seen = (await read($, quotes))[quoteKey]
  const isFresh = seen !== undefined && (await $.clock.now()) - seen.at < QUOTE_TTL_MS
  const plan = planFor(config, raw && applySets(raw, run.args.sets), await priceTable($, dir), isFresh ? seen.quote : undefined)
  const runsDir = run.args.out !== undefined ? await expand($, dir, run.args.out) : joinPath(dirname(configPath), 'runs')
  return { plan, dir, configPath, runsDir, quoteKey }
}

const setRun = ($: Engine, run: TrackedRun) => update($, runs, all => ({ ...all, [run.id]: run }))

const dropRun = ($: Engine, id: string) =>
  update($, runs, all => Object.fromEntries(Object.entries(all).filter(([key]) => key !== id)))

const rememberQuote = async ($: Engine, key: string | undefined, quote: Quote) => {
  if (key === undefined) return
  const at = await $.clock.now()
  await update($, quotes, all => ({ ...all, [key]: { quote, at } }))
}

const saveReminders = async ($: Engine, all: Record<string, Reminder>) => {
  try {
    await $.store.set(STORE_REMINDERS, all)
  } catch (error) {
    logDebug($, error)
  }
}

const addReminder = async ($: Engine, reminder: Reminder) => {
  const all = await update($, reminders, current => ({ ...current, [reminder.key]: reminder }))
  await saveReminders($, all)
}

const clearReminders = async ($: Engine, keys: readonly string[]) => {
  if (keys.length === 0) return
  const all = await update($, reminders, current => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key))))
  await saveReminders($, all)
}

// A note the model reads, for a run that ended in the background with no
// tool result left to carry it.
const appendNote = async ($: Engine, text: string) => {
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    if (appended.deny !== undefined) logDebug($, appended.deny)
  } catch (error) {
    logDebug($, error)
  }
}

const ensurePoller = ($: Engine) => {
  if (poller !== undefined) return
  poller = $.clock.every(POLL_MS, () => {
    void poll($).catch(error => logDebug($, error))
  })
}

const startTracking = async ($: Engine, toolUseId: string | undefined, run: ForjaRun): Promise<TrackedRun | undefined> => {
  try {
    const prepared = await prepare($, run)
    const { plan } = prepared
    const settings = plan.settings
    const tracked: TrackedRun = {
      id: toolUseId ?? `run-${await $.clock.now()}-${(counter += 1)}`,
      config: plan.config,
      configPath: prepared.configPath,
      quoteKey: prepared.quoteKey,
      cwd: prepared.dir,
      project: settings?.project,
      provider: plan.quote?.provider ?? settings?.provider,
      gpu: plan.quote?.gpu ?? settings?.gpus.join(' or '),
      hourlyUsd: plan.quote?.hourlyUsd,
      worstUsd: plan.quote?.worstUsd,
      maxHours: settings?.maxHours,
      runsDir: settings?.project === undefined ? undefined : prepared.runsDir,
      known: settings?.project === undefined ? [] : await listNames($, prepared.runsDir),
    }
    pendingCalls.add(tracked.id)
    await setRun($, tracked)
    ensurePoller($)
    return tracked
  } catch (error) {
    logDebug($, error)
    return undefined
  }
}

// The run folder forja created for this call: the newest `<date>_<project>_rN`
// that was not there before it.
const findRunDir = async ($: Engine, run: TrackedRun) => {
  if (run.runsDir === undefined || run.project === undefined) return undefined
  const project = run.project
  const fresh = (await listNames($, run.runsDir))
    .filter(name => isRunFolder(name, project) && !run.known.includes(name))
    .sort((a, b) => Number(a.slice(a.lastIndexOf('_r') + 2)) - Number(b.slice(b.lastIndexOf('_r') + 2)))
  const newest = fresh[fresh.length - 1]
  return newest === undefined ? undefined : joinPath(run.runsDir, newest)
}

// Ends a run: works out whether remote resources may remain, keeps a
// reminder if so, and returns the note for the model.
const finishRun = async (
  $: Engine,
  id: string,
  end: { exitCode?: number; isInterrupted: boolean; output: string },
  via: 'tool' | 'background',
): Promise<string[]> => {
  const run = (await read($, runs))[id]
  if (run === undefined) return []
  const runDir = parseRunFolder(end.output)?.runDir ?? run.runDir ?? (await findRunDir($, run))
  const state = runDir === undefined ? undefined : await readState($, runDir)
  const leftover = judgeRun({ ...end, state, couldLook: run.runsDir !== undefined })
  await dropRun($, id)
  const now = await $.clock.now()
  const name = basename(run.config)
  if (leftover !== undefined) {
    const provider = leftover.provider ?? run.provider
    await addReminder($, { key: provider ?? 'unknown', provider, why: leftoverWhy(leftover), since: now, config: run.config })
    $.ui.toast(`forja: remote resources may still exist${provider ? ` on ${provider}` : ''}. Run ${cleanupCommand(provider)}.`)
    const code = end.exitCode === undefined ? '' : ` with exit code ${end.exitCode}`
    const intro = via === 'tool' ? '' : `the background forja run for ${name} ended${code}; `
    return [leftoverNote({ ...leftover, provider }, intro)]
  }
  const startedAt = state?.createdAt ?? run.startedAt
  if (startedAt !== undefined) {
    const cost = state?.estCostUsd ?? (run.hourlyUsd === undefined ? undefined : costUsd(run.hourlyUsd, (now - startedAt) / 1000))
    const code = end.exitCode === undefined ? '' : ` (exit ${end.exitCode})`
    $.ui.toast(`forja run ${name} ended${code}${cost === undefined ? '' : `, about ${formatUsd(cost)}`}.`)
  }
  return []
}

// One look at a run: its folder, its state.json and its background output.
const refreshRun = async ($: Engine, run: TrackedRun) => {
  const now = await $.clock.now()
  let next: TrackedRun = { ...run, runDir: run.runDir ?? (await findRunDir($, run)) }
  const state = next.runDir === undefined ? undefined : await readState($, next.runDir)
  if (state !== undefined) {
    next = { ...next, status: state.status, startedAt: state.createdAt ?? next.startedAt ?? now, provider: next.provider ?? state.provider }
  }
  if (next.outputPath !== undefined) {
    const text = await readOutput($, next.outputPath)
    if (text !== undefined) {
      const quote = parseQuote(text)
      if (quote !== undefined) {
        next = { ...next, provider: quote.provider, gpu: quote.gpu, hourlyUsd: quote.hourlyUsd, worstUsd: quote.worstUsd, maxHours: quote.maxHours }
        if (run.hourlyUsd !== quote.hourlyUsd) await rememberQuote($, run.quoteKey, quote)
      }
      if (next.startedAt === undefined && /^creating remote resources on /m.test(text)) next = { ...next, startedAt: now }
      const ended = parseExitMarker(text)
      if (ended !== undefined) {
        await setRun($, next)
        const notes = await finishRun($, next.id, { exitCode: ended.exitCode, isInterrupted: ended.exitCode >= 128, output: ended.output }, 'background')
        for (const note of notes) await appendNote($, note)
        return
      }
    }
  } else if (!pendingCalls.has(next.id)) {
    // Its Bash call belongs to an earlier load of the module, so no result
    // will come: end it from state.json, or at its deadline.
    const deadline = (next.startedAt ?? now) + ((next.maxHours ?? 24) * 3600 + 1800) * 1000
    if (next.runDir === undefined || state?.gpuSeconds !== undefined || now > deadline) {
      await setRun($, next)
      const notes = await finishRun($, next.id, { isInterrupted: state?.gpuSeconds === undefined, output: '' }, 'background')
      for (const note of notes) await appendNote($, note)
      return
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(run)) await setRun($, next)
}

const poll = async ($: Engine) => {
  if (isPolling) return
  isPolling = true
  try {
    for (const id of Object.keys(await read($, runs))) {
      const run = (await read($, runs))[id]
      if (run !== undefined) await refreshRun($, run)
    }
    const left = Object.values(await read($, runs))
    if (left.length === 0) {
      poller?.cancel()
      poller = undefined
    } else if (left.some(run => run.startedAt !== undefined)) {
      const now = await $.clock.now()
      await update($, tick, () => now)
    }
  } finally {
    isPolling = false
  }
}

type BashResult = { deny?: string; isError?: boolean; text?: string; result?: unknown; context?: readonly string[] }

const afterRun = async ($: Engine, run: TrackedRun, result: BashResult): Promise<string[]> => {
  const outcome = readBashResult(result)
  if (outcome.kind === 'refused') {
    await dropRun($, run.id)
    return []
  }
  if (outcome.kind === 'background') {
    const current = (await read($, runs))[run.id] ?? run
    await setRun($, { ...current, outputPath: outcome.outputPath })
    ensurePoller($)
    return []
  }
  const quote = parseQuote(outcome.output)
  if (quote !== undefined) await rememberQuote($, run.quoteKey, quote)
  const notes = await finishRun($, run.id, outcome, 'tool')
  if (isPromptAborted(outcome.output)) notes.push(abortedNote(quote))
  return notes
}

const afterCleanup = async ($: Engine, args: CleanupArgs, result: BashResult): Promise<string[]> => {
  const outcome = readBashResult(result)
  if (outcome.kind !== 'done' || outcome.exitCode === undefined) return []
  const report = parseCleanup(outcome.output)
  const exitCode = outcome.exitCode
  const pending = await read($, reminders)
  await clearReminders($, Object.keys(pending).filter(key => cleanupClears(report, exitCode, key)))

  const notes: string[] = []
  if (report.isInterrupted && !args.isYes) notes.push(CLEANUP_PROMPT_NOTE)
  for (const key of Object.keys(pending)) {
    if (report.providers[key] === 'skipped') notes.push(skippedNote(key))
  }
  // Resources it listed and did not delete, or a provider it could not list
  // (exit 3), may still be billing.
  const now = await $.clock.now()
  for (const [provider, state] of Object.entries(report.providers)) {
    if (state !== 'left' && state !== 'unlisted') continue
    const why =
      state === 'unlisted'
        ? 'forja cleanup could not list them'
        : report.isInterrupted
          ? 'forja cleanup stopped before deleting them'
          : 'forja cleanup did not delete them all'
    await addReminder($, { key: provider, provider, why, since: now })
  }
  return notes
}

const withContext = <R extends BashResult>(result: R, notes: readonly string[]): R =>
  notes.length === 0 || result.deny !== undefined ? result : { ...result, context: [...(result.context ?? []), ...notes] }

const dismiss = ($: Engine, key: string) => clearReminders($, [key])

const refusedNote = async ($: Engine, command: string) => {
  const { runs: found, isUnparsed } = runsNeedingConfirmation(command)
  const plans: Plan[] = []
  for (const run of found) plans.push((await prepare($, run)).plan)
  return refusedText(plans, isUnparsed)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void (async () => {
      const stored = asReminders(await $.store.get(STORE_REMINDERS))
      if (Object.keys(stored).length > 0) await update($, reminders, all => ({ ...stored, ...all }))
      // A reload ends nothing forja does, but a run with neither a folder nor
      // an output file has nothing left to follow.
      const all = await read($, runs)
      for (const run of Object.values(all)) {
        if (run.outputPath === undefined && run.runDir === undefined) await dropRun($, run.id)
      }
      if (Object.keys(await read($, runs)).length > 0) ensurePoller($)
    })().catch(error => logDebug($, error))
    return started
  })

  // The cost confirmation. `--yes` skips forja's own question, so the person
  // answers this one. It fails closed: if the check breaks, the run stops.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny' || !isGuarded(e.input)) return verdict
    const command = (e.input as { command: string }).command
    const { runs: found, isUnparsed } = runsNeedingConfirmation(command)
    const plans: Plan[] = []
    for (const run of found) plans.push((await prepare($, run)).plan)
    return { decision: 'ask', reason: askText(plans, isUnparsed) }
  }).catch(($, e, next) =>
    isGuarded(e.input)
      ? {
          decision: 'deny',
          reason: `forja-cost-guard: the cost check itself failed (${next.error?.message ?? 'no reason given'}), so this forja run was stopped. Tell the person; they can run it in their own terminal, where forja asks its own cost question.`,
        }
      : next(e),
  )

  // Follows forja runs and cleanups: the band while a run goes on, the
  // cleanup reminder when one ends with remote resources possibly left.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (typeof e.command !== 'string') return next(e)
    const invocations = findForja(e.command)
    const runInvocation = invocations.find(invocation => invocation.sub === 'run')
    const cleanupInvocation = invocations.find(invocation => invocation.sub === 'cleanup')
    const runArgs = runInvocation === undefined ? undefined : parseRunArgs(runInvocation.args)
    const isRun = runInvocation !== undefined && runArgs !== undefined && !runArgs.isHelp && runArgs.config !== undefined
    const isAsked = isGuarded({ command: e.command })
    if (!isRun && cleanupInvocation === undefined && !isAsked) return next(e)

    const tracked = isRun ? await startTracking($, e.tool_use_id, { invocation: runInvocation, args: runArgs }) : undefined
    const result = await next(e)
    const notes: string[] = []
    try {
      // Not approved: say why it stopped, with the cost, so the model asks
      // the person instead of trying another way round the question.
      if (isAsked && readBashResult(result).kind === 'refused') {
        if (tracked !== undefined) await dropRun($, tracked.id)
        const refused = await refusedNote($, e.command)
        if (result.deny !== undefined) return { deny: refused }
        return withContext(result, [refused])
      }
      if (tracked !== undefined) notes.push(...(await afterRun($, tracked, result)))
      if (cleanupInvocation !== undefined) notes.push(...(await afterCleanup($, parseCleanupArgs(cleanupInvocation.args), result)))
    } catch (error) {
      logDebug($, error)
    } finally {
      if (tracked !== undefined) pendingCalls.delete(tracked.id)
    }
    return withContext(result, notes)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const live = Object.values(await read($, runs)).filter(run => run.startedAt !== undefined)
    const pending = Object.values(await read($, reminders))
    if (live.length === 0 && pending.length === 0) return next(e)
    await read($, tick)
    const now = await $.clock.now()
    const below = await next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {live.map(run => (
          <Text color="claude" wrap="truncate-end">
            {runLine(run, now)}
          </Text>
        ))}
        {pending.map(reminder => (
          <Box>
            <Text color="warning" wrap="truncate-end">
              {reminderLine(reminder)}{' '}
            </Text>
            <Button key={`dismiss:${reminder.key}`} label="Dismiss" onPress={() => dismiss($, reminder.key)} />
          </Box>
        ))}
        {below}
      </Box>
    )
  })
}
