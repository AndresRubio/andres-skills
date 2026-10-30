import { describe, expect, test } from 'claude-code/testing'

import {
  agentText,
  choosePort,
  configPath,
  exitedText,
  parsePort,
  parseStatus,
  statusLine,
  tailText,
  timeoutText,
  tomlPortValue,
  transition,
  upText,
} from '../hooks/logic'

// Answers of the real app (src/local_jev/app.py behind its fake engine),
// captured over the ASGI interface with no weights loaded.
const STATUS_200 =
  '{"version":"0.1.0","pid":94021,"backend":"fake","engine":{"backend":"fake","loaded":[],"ready":["english"]},"runtime":{"queue_depth":0,"idle_seconds":0.0,"idle_unload_seconds":900.0,"decide_latency_ms":{"count":0,"p50":null,"p95":null}},"memory":{"peak_rss_mb":66.5},"config":{"port":7711,"noul_mode":"ab_labels","idle_unload_minutes":15.0,"log_inputs":false,"token_required":false}}'
const STATUS_401 =
  '{"error": {"code": "unauthorized", "message": "missing or wrong bearer token", "hint": "send Authorization: Bearer $LOCAL_JEV_TOKEN"}}'
const HEALTH = '{"ok":true}'

describe('parsePort', () => {
  test('takes what local-jev takes', async () => {
    expect(parsePort('7711')).toBe(7711)
    expect(parsePort(' 8080 ')).toBe(8080)
    expect(parsePort('+9000')).toBe(9000)
    expect(parsePort('7_711')).toBe(7711)
    expect(parsePort('1024')).toBe(1024)
    expect(parsePort('65535')).toBe(65535)
  })

  test('refuses what it refuses', async () => {
    expect(parsePort('')).toBeUndefined()
    expect(parsePort('abc')).toBeUndefined()
    expect(parsePort('77.11')).toBeUndefined()
    expect(parsePort('1023')).toBeUndefined()
    expect(parsePort('65536')).toBeUndefined()
    expect(parsePort('-7711')).toBeUndefined()
    expect(parsePort('7711x')).toBeUndefined()
  })
})

describe('tomlPortValue', () => {
  test('reads the top-level key in the usual spellings', async () => {
    expect(tomlPortValue('port = 7711')).toBe('7711')
    expect(tomlPortValue('port=7711')).toBe('7711')
    expect(tomlPortValue('  port   =   8123   # my port')).toBe('8123')
    expect(tomlPortValue('# local-jev\nbackend = "laya-mlx"\nport = 9001\n')).toBe('9001')
    expect(tomlPortValue('port = "9001"')).toBe('9001')
    expect(tomlPortValue("port = '9001' # quoted")).toBe('9001')
    expect(tomlPortValue('"port" = 9001')).toBe('9001')
    expect(tomlPortValue('backend = "x"\r\nport = 9001\r\n')).toBe('9001')
  })

  test('ignores a port under a table, and other keys that start with port', async () => {
    expect(tomlPortValue('backend = "x"\n[remote]\nport = 1234\n')).toBeUndefined()
    expect(tomlPortValue('[remote]\nurl = ""\n')).toBeUndefined()
    expect(tomlPortValue('portal = 5555')).toBeUndefined()
    expect(tomlPortValue('# port = 5555')).toBeUndefined()
    expect(tomlPortValue('')).toBeUndefined()
  })
})

describe('configPath', () => {
  test('defaults to the config file under the home folder', async () => {
    expect(configPath(undefined, '/Users/me')).toBe('/Users/me/.config/local-jev/config.toml')
    expect(configPath('', '/Users/me')).toBe('/Users/me/.config/local-jev/config.toml')
  })

  test('takes LOCAL_JEV_CONFIG, expanding a leading ~', async () => {
    expect(configPath('/etc/jev.toml', '/Users/me')).toBe('/etc/jev.toml')
    expect(configPath('~/jev.toml', '/Users/me')).toBe('/Users/me/jev.toml')
    expect(configPath('rel/jev.toml', '/Users/me')).toBe('rel/jev.toml')
  })

  test('has no path when the home folder is unknown', async () => {
    expect(configPath(undefined, undefined)).toBeUndefined()
    expect(configPath(undefined, '')).toBeUndefined()
    expect(configPath('/etc/jev.toml', undefined)).toBe('/etc/jev.toml')
  })
})

describe('choosePort', () => {
  test('defaults to 7711', async () => {
    expect(choosePort({})).toEqual({ port: 7711, source: 'default' })
    expect(choosePort({ file: 'backend = "laya-mlx"\n' })).toEqual({ port: 7711, source: 'default' })
  })

  test('the file beats the default, the environment beats the file', async () => {
    expect(choosePort({ file: 'port = 8123' })).toEqual({ port: 8123, source: 'file' })
    expect(choosePort({ env: '9000', file: 'port = 8123' })).toEqual({ port: 9000, source: 'env' })
  })

  test('an empty variable counts as unset, as it does for local-jev', async () => {
    expect(choosePort({ env: '', file: 'port = 8123' })).toEqual({ port: 8123, source: 'file' })
  })

  test('a value local-jev would refuse is reported, and the next source is used', async () => {
    const badEnv = choosePort({ env: 'abc', file: 'port = 8123' })
    expect(badEnv.port).toBe(8123)
    expect(badEnv.problem).toContain('LOCAL_JEV_PORT is "abc"')

    const badFile = choosePort({ file: 'port = 80' })
    expect(badFile.port).toBe(7711)
    expect(badFile.problem).toContain('port = 80')
  })
})

describe('parseStatus', () => {
  test('a 200 with local-jev fields is up, with its version and pid', async () => {
    expect(parseStatus(200, STATUS_200)).toEqual({ state: 'up', version: '0.1.0', pid: 94021 })
  })

  test('a server that wants a token is up', async () => {
    expect(parseStatus(401, STATUS_401)).toEqual({ state: 'up', needsToken: true })
  })

  test('local-jev error answers other than 401 count as up', async () => {
    const body = '{"error":{"code":"internal_error","message":"unexpected server error","hint":"see server.log"}}'
    expect(parseStatus(500, body)).toEqual({ state: 'up' })
    expect(parseStatus(421, body)).toEqual({ state: 'up' })
  })

  test('something else on the port is down, not local-jev', async () => {
    expect(parseStatus(200, '<html>hello</html>')).toEqual({
      state: 'down',
      reason: 'not-local-jev',
      detail: 'HTTP 200',
    })
    expect(parseStatus(404, '{"detail":"Not Found"}')).toMatchObject({ state: 'down', reason: 'not-local-jev' })
    expect(parseStatus(200, HEALTH)).toMatchObject({ state: 'down', reason: 'not-local-jev' })
    expect(parseStatus(200, '[1,2]')).toMatchObject({ state: 'down' })
    expect(parseStatus(200, '')).toMatchObject({ state: 'down' })
  })

  test('no answer, or a gateway error from a proxy, means nobody is listening', async () => {
    expect(parseStatus(0, '')).toEqual({ state: 'down', reason: 'unreachable', detail: 'HTTP 0' })
    expect(parseStatus(502, '<html>Bad Gateway</html>')).toMatchObject({ state: 'down', reason: 'unreachable' })
    expect(parseStatus(503, '')).toMatchObject({ state: 'down', reason: 'unreachable' })
    expect(parseStatus(504, 'upstream timed out')).toMatchObject({ state: 'down', reason: 'unreachable' })
  })
})

describe('transition', () => {
  test('only up to down is a drop', async () => {
    const up = { state: 'up' } as const
    const down = { state: 'down', reason: 'unreachable' } as const
    expect(transition(undefined, up)).toEqual({ health: 'up', isDrop: false })
    expect(transition(undefined, down)).toEqual({ health: 'down', isDrop: false })
    expect(transition('up', up)).toEqual({ health: 'up', isDrop: false })
    expect(transition('up', down)).toEqual({ health: 'down', isDrop: true })
    expect(transition('down', down)).toEqual({ health: 'down', isDrop: false })
    expect(transition('down', up)).toEqual({ health: 'up', isDrop: false })
  })
})

describe('words', () => {
  test('the status line says what the brief asks for', async () => {
    expect(statusLine('up')).toBe('local-jev: up')
    expect(statusLine('down')).toBe('local-jev: down (/jev-start)')
  })

  test('the up text names the server', async () => {
    expect(upText(7711, { state: 'up', version: '0.1.0', pid: 12 })).toContain('already up on port 7711 (version 0.1.0, pid 12)')
    expect(upText(7711, { state: 'up', needsToken: true })).toContain('bearer token')
  })

  test('a loaded agent gets kickstart, an unloaded one bootstrap, an unknown one both', async () => {
    const plist = '/Users/me/Library/LaunchAgents/io.github.andresrubio.local-jev.plist'
    const loaded = agentText({ port: 7711, plist, isLoaded: true })
    expect(loaded).toContain('launchctl kickstart -k "gui/$(id -u)/io.github.andresrubio.local-jev"')
    expect(loaded).not.toContain('bootstrap')

    const unloaded = agentText({ port: 7711, plist, isLoaded: false })
    expect(unloaded).toContain(`launchctl bootstrap "gui/$(id -u)" "${plist}"`)
    expect(unloaded).not.toContain('kickstart')

    const unknown = agentText({ port: 7711, plist, isLoaded: undefined })
    expect(unknown).toContain('launchctl bootstrap')
    expect(unknown).toContain('launchctl kickstart')
    expect(unknown).toContain('did not start a second server')
  })

  test('the exit text carries what the server printed', async () => {
    expect(exitedText(7711, 'exit code 127', 'zsh:1: command not found: local-jev')).toContain('(exit code 127)')
    expect(exitedText(7711, 'exit code 127', 'zsh:1: command not found: local-jev')).toContain('command not found')
    expect(exitedText(7711, undefined, '')).toContain('printed nothing')
  })

  test('the timeout text says how long and where to look', async () => {
    expect(timeoutText(7711, '')).toContain('within 60 seconds')
    expect(timeoutText(7711, '')).toContain('server.log')
  })

  test('tailText drops colour codes and keeps the end', async () => {
    expect(tailText('\u001b[31mboom\u001b[0m\r\n')).toBe('boom')
    const long = 'x'.repeat(2_000) + 'END'
    expect(tailText(long, 10)).toBe('...xxxxxxxEND')
  })
})
