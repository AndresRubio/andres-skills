// The pure parts of jev-status: which port to ask, what an answer means,
// and what to tell the user. Nothing here touches the engine.

export const DEFAULT_PORT = 7711
// The launchd label `local-jev install-agent` uses (src/local_jev/launchd.py).
export const LABEL = 'io.github.andresrubio.local-jev'
// `local-jev status` calls this route (src/local_jev/cli.py, api_rest.py).
export const STATUS_PATH = '/v1/status'
export const DEFAULT_CONFIG = '~/.config/local-jev/config.toml'
export const SERVE_COMMAND = 'exec local-jev serve'

export const CHECK_MS = 60_000
export const PROBE_TIMEOUT_MS = 3_000
export const POLL_MS = 2_000
export const STARTUP_LIMIT_MS = 60_000

export type Health = 'up' | 'down'
export type PortSource = 'env' | 'file' | 'default'
export type PortChoice = { port: number; source: PortSource; problem?: string }

export type UpProbe = {
  state: 'up'
  version?: string
  pid?: number
  needsToken?: boolean
}
// `not-local-jev`: something answered, but not the way local-jev does.
export type DownProbe = {
  state: 'down'
  reason: 'unreachable' | 'timeout' | 'not-local-jev'
  detail?: string
}
export type Probe = UpProbe | DownProbe

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Python's int() takes " 7711 ", "+7711" and "7_711". local-jev wants 1024 to 65535.
export function parsePort(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\+?\d+(?:_\d+)*$/.test(trimmed)) return undefined
  const port = Number(trimmed.replace(/[+_]/g, ''))
  return port >= 1024 && port <= 65535 ? port : undefined
}

const scalar = (value: string): string => {
  const quoted = /^(["'])(.*?)\1/.exec(value)
  if (quoted) return quoted[2] ?? ''
  return value.replace(/\s*#.*$/, '').trim()
}

// The value of the top-level `port` key, as text. Keys after the first
// [table] header belong to that table, so the scan stops there.
export function tomlPortValue(toml: string): string | undefined {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) return undefined
    const match = /^(?:port|"port"|'port')\s*=\s*(.*)$/.exec(line)
    if (match) return scalar(match[1] ?? '')
  }
  return undefined
}

// LOCAL_JEV_CONFIG, else the default file. A leading ~ is the home folder,
// as it is for local-jev.
export function configPath(custom: string | undefined, home: string | undefined): string | undefined {
  const path = custom || DEFAULT_CONFIG
  if (path === '~' || path.startsWith('~/')) return home ? home + path.slice(1) : undefined
  return path
}

// The order local-jev uses: LOCAL_JEV_PORT, then `port` in the config file,
// then 7711. A value it would refuse is reported and skipped, so the mod
// still asks somewhere sensible.
export function choosePort(input: { env?: string; file?: string }): PortChoice {
  let problem: string | undefined
  let fromFile: number | undefined
  if (input.file !== undefined) {
    const value = tomlPortValue(input.file)
    if (value !== undefined) {
      fromFile = parsePort(value)
      if (fromFile === undefined) problem = `"port = ${value}" in the config file is not a port from 1024 to 65535.`
    }
  }
  if (input.env) {
    const port = parsePort(input.env)
    if (port !== undefined) return { port, source: 'env' }
    problem = `LOCAL_JEV_PORT is "${input.env}", not a port from 1024 to 65535.`
  }
  const base: PortChoice =
    fromFile !== undefined ? { port: fromFile, source: 'file' } : { port: DEFAULT_PORT, source: 'default' }
  return problem === undefined ? base : { ...base, problem }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// What GET /v1/status told us. Up is a 200 that carries local-jev's own
// fields, or one of its error answers (a server that wants a token says 401
// with {"error": {"code", "message", "hint"}}). Anything else that answers is
// not local-jev.
export function parseStatus(status: number, text: string): Probe {
  const body = parseJson(text)
  if (isRecord(body)) {
    if (status === 200 && (typeof body.version === 'string' || typeof body.pid === 'number')) {
      const up: UpProbe = { state: 'up' }
      if (typeof body.version === 'string') up.version = body.version
      if (typeof body.pid === 'number') up.pid = body.pid
      return up
    }
    const error = body.error
    if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
      return status === 401 ? { state: 'up', needsToken: true } : { state: 'up' }
    }
  }
  // No answer at all, or a gateway saying nothing is behind it (a proxy in
  // front of a closed port): nobody is listening, which is not a foreign server.
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return { state: 'down', reason: 'unreachable', detail: `HTTP ${status}` }
  }
  return { state: 'down', reason: 'not-local-jev', detail: `HTTP ${status}` }
}

export function transition(before: Health | undefined, probe: Probe): { health: Health; isDrop: boolean } {
  return { health: probe.state, isDrop: before === 'up' && probe.state === 'down' }
}

export const statusLine = (health: Health): string =>
  health === 'up' ? 'local-jev: up' : 'local-jev: down (/jev-start)'

export const dropToast = (port: number): string =>
  `local-jev stopped answering on port ${port}. Run /jev-start to bring it back.`

export function tailText(output: string, max = 600): string {
  const clean = output
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .trim()
  return clean.length > max ? `...${clean.slice(-max)}` : clean
}

const RECONNECT = 'If its MCP tools are still missing, reconnect the server from /mcp.'
const LOGS = '~/Library/Logs/local-jev'

const facts = (probe: UpProbe): string => {
  const parts: string[] = []
  if (probe.version !== undefined) parts.push(`version ${probe.version}`)
  if (probe.pid !== undefined) parts.push(`pid ${probe.pid}`)
  if (probe.needsToken) parts.push('it asks for a bearer token, so no more detail')
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

export const upText = (port: number, probe: UpProbe): string =>
  `local-jev is already up on port ${port}${facts(probe)}. ${RECONNECT}`

export const foreignText = (port: number, detail: string | undefined): string =>
  `Port ${port} answers${detail ? ` (${detail})` : ''}, but not as local-jev, so I did not start a server there. ` +
  'Free the port, or set "port" in ~/.config/local-jev/config.toml and run `local-jev connect` again.'

export const stillRunningText = (port: number): string =>
  `A local-jev server that this session started is still running but does not answer on port ${port} yet, ` +
  `so I did not start another. Its log is ${LOGS}/server.log. Wait a few seconds and run /jev-start again.`

export function agentText(input: { port: number; plist: string; isLoaded: boolean | undefined }): string {
  const { port, plist, isLoaded } = input
  const kickstart = `launchctl kickstart -k "gui/$(id -u)/${LABEL}"`
  const bootstrap = `launchctl bootstrap "gui/$(id -u)" "${plist}"`
  const head = `local-jev is down on port ${port}, but its login agent is installed (${plist}), so I did not start a second server.`
  if (isLoaded === true) {
    return (
      `${head} The agent is loaded, so launchd is starting it or restarting it after a crash. ` +
      `Its logs are ${LOGS}/launchd.err.log and server.log. To restart it now, run:\n${kickstart}`
    )
  }
  if (isLoaded === false) return `${head} It is not loaded. To start it, run:\n${bootstrap}`
  return `${head} To start it, run:\n${bootstrap}\nIf launchctl says it is already loaded, run:\n${kickstart}`
}

export const startingText = (port: number): string =>
  `Starting \`local-jev serve\` on port ${port} as a child of this session. It stops when the session ends. ` +
  `I will report here when it answers, for up to ${STARTUP_LIMIT_MS / 1000} seconds.`

export const startedText = (port: number, probe: UpProbe): string =>
  `local-jev is up on port ${port}${facts(probe)}, started by this session. It stops when the session ends. ${RECONNECT}`

export function exitedText(port: number, endedWith: string | undefined, tail: string): string {
  const how = endedWith === undefined ? 'ended' : `ended (${endedWith})`
  return (
    `\`local-jev serve\` ${how} before it answered on port ${port}.` +
    (tail ? `\nIts output:\n${tail}` : ' It printed nothing.')
  )
}

export const timeoutText = (port: number, tail: string): string =>
  `local-jev did not answer on port ${port} within ${STARTUP_LIMIT_MS / 1000} seconds. The server is still running; ` +
  `its log is ${LOGS}/server.log. If your shell sets LOCAL_JEV_PORT, it listens there instead.` +
  (tail ? `\nIts output:\n${tail}` : '')
