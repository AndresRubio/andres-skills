import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { McpCall } from '../types'
import {
  LAB_MARKERS,
  USAGE,
  callLine,
  clipPrompt,
  describePii,
  fitCalls,
  headLines,
  isHostServer,
  isLabName,
  outcomeOf,
  parseCommand,
  parseMcpTool,
  piiCount,
  piiText,
  piiToast,
  readLog,
  resolvePath,
  shortInput,
  statusWord,
  summaryLine,
  toJsonl,
} from './logic'
import type { LogEntry, Ran } from './logic'

type Engine = EngineInterface

const PANE = 'mcp-inspector'
const TITLE = 'MCP inspector'
const COMMAND = 'mcp-inspector'
// The store key carries a version, as the atom's shape tag does.
const LOG_KEY = 'selection-log-1'
const MAX_CALLS = 200
const MAX_LOG = 1000
const HEAD_LINES = 2
// Prompts no person typed: the engine's notices and its own follow-ups.
const MACHINE_ORIGINS = new Set(['task-notification', 'auto-continuation', 'observer', 'observer-activity'])
const STATUS_COLOR = { running: 'subtle', ok: 'success', error: 'error' } as const

// Change the tag when McpCall's fields change: it declines what an earlier
// version stored, which outlives a reload.
const calls = atom({ plugin: 'mcp-inspector', key: 'calls' } as const, [], { shape: 'calls-1' })
const turn = atom({ plugin: 'mcp-inspector', key: 'turn' } as const, '')
const autoOpened = atom({ plugin: 'mcp-inspector', key: 'autoOpened' } as const, false)

// Whether a session folder is inside mcp-lab, found once per folder.
const labByDir = new Map<string, Promise<boolean>>()
let isRegistered = false
// Log writes run one at a time, so parallel tool calls lose no entry.
let logQueue: Promise<unknown> = Promise.resolve()

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const debug = ($: Engine, error: unknown) => $.ui.log(`mcp-inspector: ${errorText(error)}`, { to: 'debug' })

const repoRoot = async ($: Engine, dir: string) => {
  try {
    const found = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir })
    return found.exitCode === 0 ? found.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

// mcp-lab by its folder name, or by the two packages only it has.
const findLab = async ($: Engine, dir: string) => {
  const root = await repoRoot($, dir)
  if (root === undefined) return false
  if (isLabName(root)) return true
  const found = await Promise.all(LAB_MARKERS.map(file => $.fs.exists(`${root}/${file}`).catch(() => false)))
  return found.every(Boolean)
}

const isActive = async ($: Engine) => {
  const dir = await $.session.cwd()
  let known = labByDir.get(dir)
  if (known === undefined) {
    known = findLab($, dir)
    labByDir.set(dir, known)
  }
  return known
}

const ensureCommand = async ($: Engine) => {
  if (isRegistered) return
  isRegistered = true
  try {
    await $.command.register({
      name: COMMAND,
      description: 'Show this session\'s MCP tool calls; "export <path>" writes the tool-selection log as JSONL, "clear" empties it',
      argumentHint: '[export <path> | clear]',
      immediate: true,
    })
  } catch (error) {
    isRegistered = false
    debug($, error)
  }
}

const withLog = ($: Engine, change: (log: LogEntry[]) => LogEntry[]) => {
  const run = logQueue.then(async () => {
    const log = change(readLog(await $.store.get(LOG_KEY))).slice(-MAX_LOG)
    await $.store.set(LOG_KEY, log)
    return log
  })
  logQueue = run.catch(() => undefined)
  return run
}

const currentLog = ($: Engine) => logQueue.then(async () => readLog(await $.store.get(LOG_KEY)))

// Adds the tool to the entry of the prompt being answered.
const noteTool = async ($: Engine, tool: string) => {
  const id = await read($, turn)
  if (id === '') return
  await withLog($, log => log.map(entry => (entry.id === id ? { ...entry, tools: [...entry.tools, tool] } : entry)))
}

// A new entry for a prompt; the MCP calls that follow are filed under it.
const openEntry = async ($: Engine, text: string) => {
  const now = await $.clock.now()
  const id = `${now}-${Math.random().toString(36).slice(2, 10)}`
  await withLog($, log => [...log, { id, prompt: clipPrompt(text), tools: [], at: new Date(now).toISOString() }])
  await update($, turn, () => id)
  return id
}

// A prompt another hook dropped never ran: its entry goes.
const dropEntry = async ($: Engine, id: string) => {
  await withLog($, log => log.filter(entry => entry.id !== id))
  await update($, turn, current => (current === id ? '' : current))
}

const openOnce = async ($: Engine) => {
  if (await read($, autoOpened)) return
  await update($, autoOpened, () => true)
  $.ui.open({ id: PANE, title: TITLE }).catch(error => debug($, error))
}

const finish = async ($: Engine, call: McpCall, ran: Ran) => {
  const outcome = outcomeOf(ran)
  const pii = piiCount(piiText(ran))
  const done: McpCall = {
    ...call,
    status: outcome.status,
    durationMs: Math.max(0, (await $.clock.now()) - call.startedAt),
    head: headLines(outcome.text, HEAD_LINES),
  }
  if (outcome.code !== undefined) done.code = outcome.code
  if (pii !== undefined) done.pii = pii
  await update($, calls, list => list.map(one => (one.id === call.id ? done : one)))
  if (pii !== undefined) $.ui.toast(piiToast(call, pii))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      if (await isActive($)) await ensureCommand($)
    } catch (error) {
      debug($, error)
    }
    return started
  })

  // Watches every MCP call: a row before it runs, its outcome after. It
  // never refuses a call: if this hook breaks, the call goes on.
  on('tool.call', async ($, e, next) => {
    const name = parseMcpTool(String(e.tool))
    if (name === undefined || isHostServer(name.server)) return next(e)
    if (!(await isActive($))) return next(e)
    await ensureCommand($)

    const input = e as unknown as Record<string, unknown>
    const call: McpCall = {
      id: String(input.tool_use_id ?? ''),
      server: name.server,
      tool: name.tool,
      input: shortInput(input),
      startedAt: await $.clock.now(),
      status: 'running',
      head: [],
    }
    if (e.agentId !== undefined) call.agentId = e.agentId
    await update($, calls, list => [...list.filter(one => one.id !== call.id), call].slice(-MAX_CALLS))
    try {
      // The selection log is the main model's choices; a subagent's are its own.
      if (e.agentId === undefined) await noteTool($, String(e.tool))
      await openOnce($)
    } catch (error) {
      debug($, error)
    }

    const ran = await next(e)
    try {
      await finish($, call, ran)
    } catch (error) {
      debug($, error)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Each prompt opens an entry of the selection log; the MCP tools called
  // until the next prompt are added to it.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.command === undefined && e.isMeta !== true && !MACHINE_ORIGINS.has(e.origin?.kind ?? '')
    if (!isPerson || !(await isActive($))) return next(e)
    await ensureCommand($)

    const id = await openEntry($, e.text).catch(error => {
      debug($, error)
      return ''
    })
    const entered = await next(e)
    if (id !== '' && 'drop' in entered && entered.drop !== undefined) {
      await dropEntry($, id).catch(error => debug($, error))
    }
    return entered
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const command = parseCommand(e.args)

    if (command.kind === 'open') {
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      const count = (await read($, calls)).length
      return {
        text: opened.isPlaced
          ? `MCP inspector: ${count} MCP call${count === 1 ? '' : 's'} so far this session.`
          : `MCP inspector: the pane is not placed yet (${opened.reason}).`,
      }
    }

    if (command.kind === 'clear') {
      const before = (await currentLog($)).length
      await withLog($, () => [])
      await update($, calls, () => [])
      await update($, turn, () => '')
      return { text: `MCP inspector: removed ${before} prompts from the tool-selection log and emptied the pane.` }
    }

    if (command.kind === 'export') {
      const log = await currentLog($)
      if (log.length === 0) {
        return { text: 'MCP inspector: the tool-selection log is empty, so nothing was written. Each prompt in mcp-lab adds a line.' }
      }
      const home = command.path.startsWith('~') ? await $.env.get('HOME') : undefined
      const target = resolvePath(command.path, await $.session.cwd(), home)
      if (target === undefined) {
        return { text: `MCP inspector: cannot place ${command.path}. Give a file path, absolute or relative to the session folder.` }
      }
      try {
        await $.fs.write(target, toJsonl(log))
      } catch (error) {
        return { text: `MCP inspector: could not write ${target}: ${errorText(error)}` }
      }
      const tools = log.reduce((sum, entry) => sum + entry.tools.length, 0)
      return { text: `MCP inspector: wrote ${log.length} prompts (${tools} MCP tool calls) to ${target} as JSONL.` }
    }

    return { text: command.reason === undefined ? USAGE : `MCP inspector: ${command.reason} ${USAGE}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, calls)
    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            No MCP tool calls yet.
          </Text>
        </Box>
      )
    }

    const bodyRows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : (e.viewport?.rows ?? 24) - 4
    const { shown, hidden } = fitCalls(list, Math.max(1, bodyRows - 1))
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {summaryLine(list, hidden)}
        </Text>
        {shown.map(call => (
          <Box key={`call:${call.id}`} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={STATUS_COLOR[call.status]}>{statusWord(call)}</Text> {callLine(call)}
            </Text>
            {call.pii !== undefined && (
              <Text color="warning" wrap="truncate-end">
                {`  ! personal data: ${describePii(call.pii)}, which the gateway should have redacted`}
              </Text>
            )}
            {call.head.map(line => (
              <Text dimColor wrap="truncate-end">
                {`  ${line}`}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
