import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult, ToolCallArgs, ToolCallResult } from 'claude-code'

import { LAB_MARKERS } from '../hooks/logic'
import { ERROR_32021 } from './real-output'

const LAB = '/work/mcp-lab'
// 2026-10-30T09:00:00.000Z
const T0 = 1_793_350_800_000

const ok = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Answer = { result: unknown; text?: string; isError?: true } | { deny: string }

type World = {
  cwd: string
  // What `git rev-parse --show-toplevel` answers; '' for a folder outside git.
  root: string
  hasMarkers: boolean
  // The store refuses every read and write.
  isStoreBroken: boolean
  // Prompts a hook beneath drops.
  dropped: string[]
  latency: Record<string, number>
  answers: Record<string, Answer>
  toasts: string[]
  opened: string[]
  registered: string[]
  written: { path: string; text: string }[]
  // The tools that reached the bottom: every call goes on.
  reached: string[]
  clock: MockClock
}

// Stands for the engine with a session in mcp-lab: git, the file system, the
// UI and the MCP servers beneath the plugin.
function lab(on: On, overrides: Partial<Omit<World, 'clock'>> = {}): World {
  const clock = mock.clock(on, { now: T0 })
  const world: World = {
    cwd: LAB,
    root: LAB,
    hasMarkers: true,
    isStoreBroken: false,
    dropped: [],
    latency: {},
    answers: {},
    toasts: [],
    opened: [],
    registered: [],
    written: [],
    reached: [],
    clock,
    ...overrides,
  }
  // The plugin's store, which can break mid-test.
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => (world.isStoreBroken ? { deny: 'store unreadable' } : { value: store.get(e.key) }))
  on('store.set', (_, e) => {
    if (world.isStoreBroken) return { deny: 'store unwritable' }
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: world.cwd }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv === 'git rev-parse --show-toplevel') {
      expect(e.init?.cwd).toBe(world.cwd)
      return world.root === '' ? ok('', 128) : ok(`${world.root}\n`)
    }
    throw new Error(`unexpected command: ${argv}`)
  })
  on('fs.exists', (_, e) => ({ value: world.hasMarkers && LAB_MARKERS.some(file => e.path === `${world.root}/${file}`) }))
  on('fs.write', (_, e) => {
    world.written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', (_, e) => {
    world.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.submit', (_, e) => (world.dropped.includes(e.text) ? { drop: 'dropped by policy' } : { text: e.text }))
  on('tool.call', async (_, e) => {
    const tool = String(e.tool)
    world.reached.push(tool)
    const wait = world.latency[tool] ?? 0
    if (wait > 0) await clock.sleep(wait)
    return world.answers[tool] ?? { result: 'done', text: 'done' }
  })
  return world
}

// An MCP call as the model makes one. Its arguments are loose: the lab's
// servers need not be connected where the types were laid.
function mcp($: Engine, tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  return $.tool.call({ tool, ...args } as unknown as ToolCallArgs)
}

// A prompt the person typed at the composer.
function ask($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

// `/mcp-inspector <args>` typed at the composer.
function inspector($: Engine, args: string) {
  return $.command.run({
    command: 'mcp-inspector',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
}

const PANE = {
  plugin: 'mcp-inspector',
  component: 'Pane',
  requestId: 'mcp-inspector',
  props: {
    title: 'MCP inspector',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// The texts the pane draws, top to bottom.
async function pane($: Engine, surface: (typeof SURFACES)[number] = 'desktop', bodyRows = 30): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows } }, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  await ui.unmount()
  return texts
}

// The call rows among them. The status word is a Text of its own inside the
// row's Text, so a row is the text that goes on past it.
const callRows = (texts: string[]) => texts.filter(text => /^(ok|error|runs)\s+\S/.test(text))

const START = { cwd: LAB, surface: 'desktop', isInteractive: true } as const

const INCIDENTS =
  '{"incidents":[{"id":"INC-101","service":"api","title":"Elevated 5xx on /checkout","status":"open","description":"Reported by customer [REDACTED:email]: checkout fails intermittently."}]}'

test('MCP calls get rows and other tools do not, on terminal and desktop', async ($, on) => {
  const world = lab(on, {
    answers: {
      mcp__opsdesk__list_incidents: { result: INCIDENTS, text: INCIDENTS },
      mcp__pager__oncall_for: { result: 'x', text: '{"service":"api","primary":"[REDACTED:email]"}\nsecond line\nthird line' },
    },
  })
  await $.session.start(START)
  expect(world.registered).toEqual(['mcp-inspector'])

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(world.opened).toEqual([])

  const ran = await mcp($, 'mcp__opsdesk__list_incidents', { status: 'open' })
  expect(ran.text).toBe(INCIDENTS)
  await mcp($, 'mcp__pager__oncall_for', { service: 'api' })
  await $.tool.call({ tool: 'Read', file_path: '/work/mcp-lab/README.md' })

  // It opened by itself at the first MCP call, once.
  expect(world.opened).toEqual(['mcp-inspector'])
  expect(world.reached).toEqual(['Bash', 'mcp__opsdesk__list_incidents', 'mcp__pager__oncall_for', 'Read'])
  expect(world.toasts).toEqual([])

  for (const surface of SURFACES) {
    const texts = await pane($, surface)
    expect(texts[0]).toBe('2 MCP calls')
    const rows = callRows(texts)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('opsdesk/list_incidents  status=open')
    expect(rows[1]).toContain('pager/oncall_for  service=api')
    expect(texts).toContain(`  ${INCIDENTS}`)
    // The first two lines of a result, not the third.
    expect(texts).toContain('  second line')
    expect(texts.some(text => text.includes('third line'))).toBe(false)
    expect(texts.some(text => /Bash|Read/.test(text))).toBe(false)
  }
})

test('durations come from the clock', async ($, on) => {
  const world = lab(on, { latency: { mcp__opsdesk__get_service_status: 1400, mcp__opsdesk__list_incidents: 350 } })
  await $.session.start(START)

  const slow = mcp($, 'mcp__opsdesk__get_service_status', { service: 'payments' })
  await world.clock.settle()
  const running = (await pane($)).find(text => text.includes('get_service_status'))
  expect(running).toMatch(/^runs\s+\.\.\.\s+opsdesk\/get_service_status/)

  await world.clock.advance(1400)
  await slow
  const fast = mcp($, 'mcp__opsdesk__list_incidents')
  await world.clock.settle()
  await world.clock.advance(350)
  await fast

  const rows = callRows(await pane($))
  expect(rows[0]).toMatch(/^ok\s+1\.4 s\s+opsdesk\/get_service_status/)
  expect(rows[1]).toMatch(/^ok\s+350 ms\s+opsdesk\/list_incidents/)
})

test('an errored call shows its JSON-RPC error code', async ($, on) => {
  // The real server's -32021, as Claude Code words it.
  const failure = ERROR_32021
  const world = lab(on, {
    answers: {
      mcp__opsdesk__restart_service: { isError: true, result: failure, text: failure },
      mcp__opsdesk__run_diagnostics: { isError: true, result: "Unknown tool: 'run_diagnostics'", text: "Unknown tool: 'run_diagnostics'" },
      mcp__pager__send_page: { deny: 'Permission to use mcp__pager__send_page was denied.' },
    },
  })
  await $.session.start(START)

  const ran = await mcp($, 'mcp__opsdesk__restart_service', { service: 'search' })
  // The result goes back to the model untouched.
  expect(ran.isError).toBe(true)
  expect(ran.text).toBe(failure)
  await mcp($, 'mcp__opsdesk__run_diagnostics', { service: 'api' })
  await mcp($, 'mcp__pager__send_page', { service: 'api' })

  for (const surface of SURFACES) {
    const texts = await pane($, surface)
    expect(texts[0]).toBe('3 MCP calls, 3 errors')
    const rows = callRows(texts)
    expect(rows[0]).toMatch(/^error\s+0 ms\s+-32021\s+opsdesk\/restart_service\s+service=search$/)
    expect(rows[1]).toMatch(/^error\s+0 ms\s+opsdesk\/run_diagnostics/)
    expect(rows[2]).toContain('pager/send_page')
    expect(texts).toContain(`  ${failure.replace(/<\/?tool_use_error>/g, '')}`)
    expect(texts).toContain('  Permission to use mcp__pager__send_page was denied.')
  }
  expect(world.toasts).toEqual([])
})

test('personal data in a result marks the row and shows a toast', async ($, on) => {
  const leaked = '{"service":"api","primary":"dana.lee@example.com","phone":"+1 415 555 0132"}'
  const clean = '{"service":"api","primary":"[REDACTED:email]","since":"2026-10-30T09:12:00Z","build":"2.1.309","host":"10.0.0.1:8080"}'
  const world = lab(on, {
    answers: {
      mcp__pager__oncall_for: { result: leaked, text: leaked },
      mcp__gateway__oncall_for: { result: clean, text: clean },
    },
  })
  await $.session.start(START)

  await mcp($, 'mcp__gateway__oncall_for', { service: 'api' })
  expect(world.toasts).toEqual([])
  await mcp($, 'mcp__pager__oncall_for', { service: 'api' })

  expect(world.toasts).toEqual([
    "MCP inspector: pager/oncall_for returned 1 email address and 1 phone number. The gateway's redaction should have removed them.",
  ])
  for (const surface of SURFACES) {
    const texts = await pane($, surface)
    expect(texts[0]).toBe('2 MCP calls, 1 with personal data')
    const flags = texts.filter(text => text.includes('personal data:'))
    expect(flags).toEqual(['  ! personal data: 1 email address and 1 phone number, which the gateway should have redacted'])
    // The flag sits under the pager row, not the gateway's.
    expect(texts.indexOf(flags[0] ?? '')).toBeGreaterThan(texts.findIndex(text => text.includes('pager/oncall_for')))
  }
})

test('the export writes one JSONL line per prompt with the MCP tools of its turn', async ($, on) => {
  const world = lab(on)
  mock.env(on, { HOME: '/Users/me' })
  await $.session.start(START)

  await ask($, 'which services are down?')
  await mcp($, 'mcp__opsdesk__get_service_status', { service: 'search' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await mcp($, 'mcp__opsdesk__list_incidents', { status: 'open' })

  await world.clock.advance(60_000)
  await ask($, 'restart search')
  await mcp($, 'mcp__opsdesk__restart_service', { service: 'search' })
  // A subagent's call shows in the pane but is not the main model's choice.
  await $.tool.call({ tool: 'mcp__opsdesk__list_incidents', agentId: 'a1' } as unknown as ToolCallArgs & { agentId: string })

  await world.clock.advance(1_000)
  await ask($, 'thanks, that is all')

  const reply = await inspector($, 'export m3/selection.jsonl')
  expect(reply.text).toBe(
    `MCP inspector: wrote 3 prompts (3 MCP tool calls) to ${LAB}/m3/selection.jsonl as JSONL.`,
  )
  expect(world.written).toHaveLength(1)
  expect(world.written[0]?.path).toBe(`${LAB}/m3/selection.jsonl`)
  const lines = (world.written[0]?.text ?? '').split('\n')
  expect(lines.pop()).toBe('')
  expect(lines.map(line => JSON.parse(line))).toEqual([
    {
      prompt: 'which services are down?',
      tools: ['mcp__opsdesk__get_service_status', 'mcp__opsdesk__list_incidents'],
      at: '2026-10-30T09:00:00.000Z',
    },
    { prompt: 'restart search', tools: ['mcp__opsdesk__restart_service'], at: '2026-10-30T09:01:00.000Z' },
    { prompt: 'thanks, that is all', tools: [], at: '2026-10-30T09:01:01.000Z' },
  ])
  expect(await pane($)).toContain('4 MCP calls')

  await inspector($, 'export ~/evals/m3.jsonl')
  expect(world.written[1]?.path).toBe('/Users/me/evals/m3.jsonl')
  expect(world.written[1]?.text).toBe(world.written[0]?.text)
})

test('clear empties the log and the pane', async ($, on) => {
  const world = lab(on)
  await $.session.start(START)
  await ask($, 'which services are down?')
  await mcp($, 'mcp__opsdesk__list_incidents')
  expect((await pane($))[0]).toBe('1 MCP call')

  const reply = await inspector($, 'clear')
  expect(reply.text).toBe('MCP inspector: removed 1 prompts from the tool-selection log and emptied the pane.')
  for (const surface of SURFACES) {
    expect(await pane($, surface)).toEqual(['No MCP tool calls yet.'])
  }

  // A call later in the same turn is no longer filed under the cleared prompt.
  await mcp($, 'mcp__opsdesk__get_service_status', { service: 'api' })
  const empty = await inspector($, 'export /tmp/m3.jsonl')
  expect(empty.text).toContain('the tool-selection log is empty, so nothing was written')
  expect(world.written).toEqual([])
})

test('outside mcp-lab the mod stays inert', async ($, on) => {
  const leaked = 'contact dana.lee@example.com'
  const world = lab(on, {
    cwd: '/work/other',
    root: '/work/other',
    hasMarkers: false,
    answers: { mcp__pager__oncall_for: { result: leaked, text: leaked } },
  })
  await $.session.start({ ...START, cwd: '/work/other' })
  await ask($, 'who is on call?')
  const ran = await mcp($, 'mcp__pager__oncall_for', { service: 'api' })

  expect(ran.text).toBe(leaked)
  expect(world.reached).toEqual(['mcp__pager__oncall_for'])
  expect(world.registered).toEqual([])
  expect(world.opened).toEqual([])
  expect(world.toasts).toEqual([])
  expect(await pane($, 'terminal')).toEqual(['No MCP tool calls yet.'])
})

test('a folder outside git is inert too', async ($, on) => {
  const world = lab(on, { cwd: '/tmp/scratch', root: '', hasMarkers: false })
  await $.session.start({ ...START, cwd: '/tmp/scratch' })
  await mcp($, 'mcp__opsdesk__list_incidents')

  expect(world.registered).toEqual([])
  expect(world.opened).toEqual([])
  expect(await pane($)).toEqual(['No MCP tool calls yet.'])
})

test('a worktree of mcp-lab counts as mcp-lab', async ($, on) => {
  const tree = `${LAB}/.claude/worktrees/agent-1`
  const world = lab(on, { cwd: tree, root: tree })
  await $.session.start({ ...START, cwd: tree })
  await mcp($, 'mcp__opsdesk__list_incidents')

  expect(world.registered).toEqual(['mcp-inspector'])
  expect((await pane($))[0]).toBe('1 MCP call')
})

test('the pane fits its rows, newest at the bottom', async ($, on) => {
  lab(on)
  await $.session.start(START)
  for (let n = 1; n <= 12; n++) await mcp($, 'mcp__opsdesk__get_service_status', { service: `svc-${n}` })

  for (const surface of SURFACES) {
    // A summary row, then four calls of two rows each.
    const texts = await pane($, surface, 9)
    expect(texts[0]).toBe('12 MCP calls, 8 older above')
    const rows = callRows(texts)
    expect(rows.map(row => /svc-\d+/.exec(row)?.[0])).toEqual(['svc-9', 'svc-10', 'svc-11', 'svc-12'])
  }
})

test('/mcp-inspector opens the pane and explains its arguments', async ($, on) => {
  const world = lab(on)
  await $.session.start(START)

  const opened = await inspector($, '')
  expect(opened.text).toBe('MCP inspector: 0 MCP calls so far this session.')
  expect(world.opened).toEqual(['mcp-inspector'])

  const usage = await inspector($, 'bogus')
  expect(usage.text).toContain('unknown argument "bogus"')
  expect(usage.text).toContain('/mcp-inspector export <path>')
})

test('a broken store neither stops a prompt or a call nor leaves a row running', async ($, on) => {
  const world = lab(on)
  await $.session.start(START)
  await ask($, 'which services are down?')

  // The store breaks after the prompt's entry was written.
  world.isStoreBroken = true
  const ran = await mcp($, 'mcp__opsdesk__list_incidents')
  const entered = await ask($, 'and now?')

  expect(ran.text).toBe('done')
  expect(entered).toEqual({ text: 'and now?' })
  expect(world.reached).toEqual(['mcp__opsdesk__list_incidents'])
  const rows = callRows(await pane($))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatch(/^ok\s+0 ms\s+opsdesk\/list_incidents/)
})

test('a prompt dropped beneath leaves no entry, and its calls go to no prompt', async ($, on) => {
  const world = lab(on, { dropped: ['paste my api key'] })
  await $.session.start(START)
  await ask($, 'which services are down?')
  await mcp($, 'mcp__opsdesk__list_incidents')
  expect(await ask($, 'paste my api key')).toEqual({ drop: 'dropped by policy' })
  await mcp($, 'mcp__opsdesk__get_service_status', { service: 'api' })

  await inspector($, 'export /tmp/m3.jsonl')
  expect((world.written[0]?.text ?? '').trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { prompt: 'which services are down?', tools: ['mcp__opsdesk__list_incidents'], at: '2026-10-30T09:00:00.000Z' },
  ])
})
