import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { CHECK_MS, POLL_MS, PROBE_TIMEOUT_MS } from '../hooks/logic'

const HOME = '/Users/me'
const SHELL = '/bin/zsh'
const PLIST = `${HOME}/Library/LaunchAgents/io.github.andresrubio.local-jev.plist`
const CONFIG = `${HOME}/.config/local-jev/config.toml`
const SERVE = [SHELL, '-ic', 'exec local-jev serve']
const UP = 'local-jev: up'
const DOWN = 'local-jev: down (/jev-start)'
const DROPPED = 'local-jev stopped answering on port 7711. Run /jev-start to bring it back.'

// What the real app answers (see logic.test.ts for where these came from).
const STATUS_200 =
  '{"version":"0.1.0","pid":94021,"backend":"fake","engine":{"backend":"fake","loaded":[],"ready":["english"]},"memory":{"peak_rss_mb":66.5},"config":{"port":7711,"token_required":false}}'
const STATUS_401 =
  '{"error": {"code": "unauthorized", "message": "missing or wrong bearer token", "hint": "send Authorization: Bearer $LOCAL_JEV_TOKEN"}}'

const ok = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const reply = (status: number, text: string) => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text },
})

type Answer = 'jev' | 'token' | 'foreign' | 'refused' | 'slow'
type Serve = { output: string; exitAfterMs?: number; exitCode: number }

type World = {
  clock: ReturnType<typeof mock.clock>
  // The server: how it answers, and from when ('jev' only).
  answer: Answer
  upAt: number
  // Makes the next fetch, and only that one, answer after the timeout.
  slowOnce: boolean
  files: Record<string, string>
  hasPlist: boolean
  // launchctl print: true, false, or 'cannot ask' (the call fails).
  isLoaded: boolean | 'cannot ask'
  serve: Serve
  fetches: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  logs: string[]
  debug: string[]
  registered: string[]
  launchctl: number
  spawns: string[][]
}

// Stands for the engine, the machine and the server beneath the plugin.
function machine(on: On, overrides: Partial<World> = {}, env: Record<string, string> = {}): World {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = {
    clock,
    answer: 'jev',
    upAt: 0,
    slowOnce: false,
    files: {},
    hasPlist: false,
    isLoaded: false,
    serve: { output: '', exitCode: 0 },
    fetches: [],
    statuses: [],
    toasts: [],
    logs: [],
    debug: [],
    registered: [],
    launchctl: 0,
    spawns: [],
    ...overrides,
  }
  mock.env(on, { HOME, ...env })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    world.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    ;(e.to === 'debug' ? world.debug : world.logs).push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = world.files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.exists', (_, e) => ({ value: e.path === PLIST ? world.hasPlist : e.path in world.files }))
  on('http.fetch', async (_, e) => {
    world.fetches.push(e.url)
    if (world.slowOnce || world.answer === 'slow') {
      world.slowOnce = false
      // Longer than the probe's timeout: the answer comes too late.
      await clock.sleep(20_000)
      return reply(200, STATUS_200)
    }
    if (world.answer === 'foreign') return reply(200, '<html>welcome</html>')
    if (world.answer === 'token') return reply(401, STATUS_401)
    if (world.answer === 'jev' && clock.now() >= world.upAt) return reply(200, STATUS_200)
    return { deny: 'connect ECONNREFUSED 127.0.0.1' }
  })
  on('process.run', (_, e) => {
    const script = e.argv[2] ?? ''
    if (e.argv[0] === '/bin/sh' && script.includes('"$HOME"')) return ok(`${SHELL}\n${HOME}`)
    if (script.includes('launchctl print')) {
      world.launchctl += 1
      if (world.isLoaded === 'cannot ask') return { deny: 'sh is gone' }
      return ok('', world.isLoaded ? 0 : 113)
    }
    throw new Error(`unexpected command: ${e.argv.join(' ')}`)
  })
  on('process.spawn', async function* (_, e) {
    world.spawns.push([...e.argv])
    if (world.serve.output) yield { stream: 'stderr' as const, text: world.serve.output }
    // Without an exit time the server runs for as long as the session does.
    await clock.sleep(world.serve.exitAfterMs ?? 24 * 3_600_000)
    return { value: { code: world.serve.exitCode, signal: null } }
  })
  return world
}

async function start($: Engine, world: World) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await world.clock.settle()
}

// /jev-start's own answer; the polling it starts runs on from here.
async function jevStart($: Engine, world: World) {
  const ran = await $.command.run({
    command: 'jev-start',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  await world.clock.settle()
  return ran.text ?? ''
}

const lastStatus = (world: World) => world.statuses.at(-1)

test('session start registers /jev-start and shows the server as up', async ($, on) => {
  const world = machine(on)

  await start($, world)

  expect(world.registered).toEqual(['jev-start'])
  expect(world.fetches).toEqual(['http://127.0.0.1:7711/v1/status'])
  expect(lastStatus(world)).toBe(UP)
  expect(world.toasts).toEqual([])
})

test('a server that is not running shows as down, with no toast', async ($, on) => {
  const world = machine(on, { answer: 'refused' })

  await start($, world)

  expect(lastStatus(world)).toBe(DOWN)
  expect(world.toasts).toEqual([])
})

test('the status is checked again every 60 seconds', async ($, on) => {
  const world = machine(on)
  await start($, world)

  await world.clock.advance(CHECK_MS - 1)
  expect(world.fetches).toHaveLength(1)
  await world.clock.advance(1)
  expect(world.fetches).toHaveLength(2)
  await world.clock.advance(CHECK_MS)
  expect(world.fetches).toHaveLength(3)
  expect(world.debug).toEqual([])
})

test('a server that goes from up to down gets one toast each time it drops', async ($, on) => {
  const world = machine(on)
  await start($, world)
  expect(lastStatus(world)).toBe(UP)

  world.answer = 'refused'
  await world.clock.advance(CHECK_MS)
  expect(lastStatus(world)).toBe(DOWN)
  expect(world.toasts).toEqual([DROPPED])

  // Still down: the line stays, no second toast.
  await world.clock.advance(CHECK_MS)
  expect(lastStatus(world)).toBe(DOWN)
  expect(world.toasts).toHaveLength(1)

  // Back up, then down again: a new drop, a new toast.
  world.answer = 'jev'
  await world.clock.advance(CHECK_MS)
  expect(lastStatus(world)).toBe(UP)
  world.answer = 'refused'
  await world.clock.advance(CHECK_MS)
  expect(world.toasts).toEqual([DROPPED, DROPPED])
})

test('a server that is slow to answer is down after the timeout', async ($, on) => {
  const world = machine(on, { answer: 'slow' })

  await start($, world)
  expect(lastStatus(world)).toBeUndefined()
  await world.clock.advance(PROBE_TIMEOUT_MS)

  expect(lastStatus(world)).toBe(DOWN)
})

test('one slow answer from a server that was up is not a drop', async ($, on) => {
  const world = machine(on)
  await start($, world)

  world.slowOnce = true
  await world.clock.advance(CHECK_MS)
  await world.clock.advance(PROBE_TIMEOUT_MS)

  expect(world.fetches).toHaveLength(3)
  expect(lastStatus(world)).toBe(UP)
  expect(world.toasts).toEqual([])
})

test('two slow answers in a row from a server that was up are a drop', async ($, on) => {
  const world = machine(on)
  await start($, world)

  world.answer = 'slow'
  await world.clock.advance(CHECK_MS)
  await world.clock.advance(PROBE_TIMEOUT_MS)
  await world.clock.advance(PROBE_TIMEOUT_MS)

  expect(world.fetches).toHaveLength(3)
  expect(lastStatus(world)).toBe(DOWN)
  expect(world.toasts).toEqual([DROPPED])
})

test('a server that asks for a token is up', async ($, on) => {
  const world = machine(on, { answer: 'token' })

  await start($, world)

  expect(lastStatus(world)).toBe(UP)
})

test('something else on the port is down', async ($, on) => {
  const world = machine(on, { answer: 'foreign' })

  await start($, world)

  expect(lastStatus(world)).toBe(DOWN)
})

test('LOCAL_JEV_PORT sets the port', async ($, on) => {
  const world = machine(on, {}, { LOCAL_JEV_PORT: '9000' })

  await start($, world)

  expect(world.fetches).toEqual(['http://127.0.0.1:9000/v1/status'])
})

test('the config file sets the port', async ($, on) => {
  const world = machine(on, { files: { [CONFIG]: '# local-jev\nport = 8123\n[batch]\nmax_items = 5\n' } })

  await start($, world)

  expect(world.fetches).toEqual(['http://127.0.0.1:8123/v1/status'])
})

test('the variable beats the config file', async ($, on) => {
  const world = machine(on, { files: { [CONFIG]: 'port = 8123\n' } }, { LOCAL_JEV_PORT: '9000' })

  await start($, world)

  expect(world.fetches).toEqual(['http://127.0.0.1:9000/v1/status'])
})

test('LOCAL_JEV_CONFIG names another config file', async ($, on) => {
  const world = machine(on, { files: { '/etc/jev.toml': 'port = 8222\n' } }, { LOCAL_JEV_CONFIG: '/etc/jev.toml' })

  await start($, world)

  expect(world.fetches).toEqual(['http://127.0.0.1:8222/v1/status'])
})

test('/jev-start says so when the server is up, and starts nothing', async ($, on) => {
  const world = machine(on, { hasPlist: true })

  const text = await jevStart($, world)

  expect(text).toContain('already up on port 7711 (version 0.1.0, pid 94021)')
  expect(world.spawns).toEqual([])
  expect(world.launchctl).toBe(0)
  expect(lastStatus(world)).toBe(UP)
})

test('/jev-start with a loaded login agent gives the kickstart command and starts nothing', async ($, on) => {
  const world = machine(on, { answer: 'refused', hasPlist: true, isLoaded: true })

  const text = await jevStart($, world)

  expect(text).toContain('login agent is installed')
  expect(text).toContain('did not start a second server')
  expect(text).toContain('launchctl kickstart -k "gui/$(id -u)/io.github.andresrubio.local-jev"')
  expect(world.spawns).toEqual([])
})

test('/jev-start with an installed but unloaded login agent gives the bootstrap command', async ($, on) => {
  const world = machine(on, { answer: 'refused', hasPlist: true, isLoaded: false })

  const text = await jevStart($, world)

  expect(text).toContain(`launchctl bootstrap "gui/$(id -u)" "${PLIST}"`)
  expect(text).not.toContain('kickstart')
  expect(world.spawns).toEqual([])
})

test('/jev-start gives both commands when it cannot tell whether the agent is loaded', async ($, on) => {
  const world = machine(on, { answer: 'refused', hasPlist: true, isLoaded: 'cannot ask' })

  const text = await jevStart($, world)

  expect(text).toContain('launchctl bootstrap')
  expect(text).toContain('launchctl kickstart')
  expect(world.spawns).toEqual([])
})

test('/jev-start with no login agent starts the server and reports when it answers', { timeoutMs: 30_000 }, async ($, on) => {
  const world = machine(on, { answer: 'jev', upAt: Number.POSITIVE_INFINITY })

  const text = await jevStart($, world)

  expect(text).toContain('Starting `local-jev serve` on port 7711')
  // Through the user's interactive shell, as one server and nothing else.
  expect(world.spawns).toEqual([SERVE])
  expect(world.launchctl).toBe(0)
  expect(lastStatus(world)).toBe(DOWN)

  // It answers 7 seconds from now: the polls at 2, 4 and 6 seconds miss it.
  world.upAt = world.clock.now() + 7_000
  await world.clock.advance(3 * POLL_MS)
  expect(world.logs).toEqual([])
  await world.clock.advance(POLL_MS)

  expect(world.logs).toHaveLength(1)
  expect(world.logs[0]).toContain('local-jev is up on port 7711 (version 0.1.0, pid 94021), started by this session')
  expect(world.toasts).toEqual(['local-jev is up on port 7711'])
  expect(lastStatus(world)).toBe(UP)

  // The polling has stopped.
  const fetched = world.fetches.length
  await world.clock.advance(10 * POLL_MS)
  expect(world.fetches).toHaveLength(fetched)
  expect(world.debug).toEqual([])
})

test('/jev-start gives up after 60 seconds and does not start a second server on the next try', { timeoutMs: 30_000 }, async ($, on) => {
  const world = machine(on, { answer: 'refused', serve: { output: 'loading...\n', exitCode: 0 } })

  await jevStart($, world)
  await world.clock.advance(60_000 - POLL_MS)
  expect(world.logs).toEqual([])
  await world.clock.advance(POLL_MS)

  expect(world.logs).toHaveLength(1)
  expect(world.logs[0]).toContain('did not answer on port 7711 within 60 seconds')
  expect(world.logs[0]).toContain('loading...')
  expect(world.toasts).toEqual(['local-jev did not answer on port 7711. See the transcript.'])
  expect(lastStatus(world)).toBe(DOWN)

  // Polling stopped at the limit.
  const fetched = world.fetches.length
  await world.clock.advance(10 * POLL_MS)
  expect(world.fetches).toHaveLength(fetched)

  const again = await jevStart($, world)
  expect(again).toContain('still running but does not answer')
  expect(world.spawns).toHaveLength(1)
})

test('a second /jev-start while the first server is starting does not start another', async ($, on) => {
  const world = machine(on, { answer: 'refused' })

  await jevStart($, world)
  const again = await jevStart($, world)

  expect(again).toContain('still running but does not answer')
  expect(world.spawns).toHaveLength(1)
})

test('/jev-start reports a server that exits at once, with what it printed', async ($, on) => {
  const world = machine(on, {
    answer: 'refused',
    serve: { output: 'zsh:1: command not found: local-jev\n', exitAfterMs: 0, exitCode: 127 },
  })

  await jevStart($, world)
  await world.clock.advance(POLL_MS)

  expect(world.logs).toHaveLength(1)
  expect(world.logs[0]).toContain('ended (exit code 127) before it answered on port 7711')
  expect(world.logs[0]).toContain('command not found: local-jev')
  expect(world.toasts).toEqual(['local-jev did not start on port 7711. See the transcript.'])

  // The child is gone, so the next try starts a new one.
  await jevStart($, world)
  expect(world.spawns).toHaveLength(2)
})

test('/jev-start does not start a server on a port something else holds', async ($, on) => {
  const world = machine(on, { answer: 'foreign' })

  const text = await jevStart($, world)

  expect(text).toContain('answers (HTTP 200), but not as local-jev')
  expect(world.spawns).toEqual([])
})

test('/jev-start asks the configured port and says when the configuration is wrong', async ($, on) => {
  const world = machine(on, { answer: 'refused', hasPlist: true, isLoaded: true }, { LOCAL_JEV_PORT: 'abc' })

  const text = await jevStart($, world)

  expect(world.fetches).toEqual(['http://127.0.0.1:7711/v1/status'])
  expect(text).toContain('Note: LOCAL_JEV_PORT is "abc"')
})
