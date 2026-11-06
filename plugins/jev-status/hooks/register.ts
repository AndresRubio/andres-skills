import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  CHECK_MS,
  LABEL,
  POLL_MS,
  PROBE_TIMEOUT_MS,
  SERVE_COMMAND,
  STARTUP_LIMIT_MS,
  STATUS_PATH,
  agentText,
  choosePort,
  configPath,
  dropToast,
  exitedText,
  foreignText,
  parseStatus,
  startedText,
  startingText,
  statusLine,
  stillRunningText,
  tailText,
  timeoutText,
  transition,
  upText,
} from './logic'
import type { Health, PortChoice, Probe } from './logic'

type Engine = EngineInterface

// A server this session started with /jev-start.
type Child = { isRunning: boolean; endedWith?: string; tail: string }

const TAIL_KEEP = 4_000

// What the last probe said; the toast needs the one before it. A reload
// resets these, and `session.start` runs again then.
let last: Health | undefined
let ticker: Timer | undefined
let child: Child | undefined
let host: { shell: string; home: string } | undefined

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The user's shell starts the server (`-ic`, so the PATH from their rc file
// finds local-jev, which lives in ~/.local/bin); zsh, macOS's default, where
// SHELL is unset.
const hostInfo = async ($: Engine) => {
  if (host) return host
  const { stdout } = await $.process.run([
    '/bin/sh',
    '-c',
    's=${SHELL:-}; [ -n "$s" ] || { [ -x /bin/zsh ] && s=/bin/zsh || s=/bin/sh; }; printf "%s\\n%s" "$s" "$HOME"',
  ])
  const [shell, home] = stdout.split('\n')
  host = { shell: shell || '/bin/sh', home: home ?? '' }
  return host
}

const homeDir = async ($: Engine) => (await $.env.get('HOME')) || (await hostInfo($)).home

// Port: LOCAL_JEV_PORT, else `port` in the config file, else 7711.
const readPort = async ($: Engine): Promise<PortChoice> => {
  try {
    const env = await $.env.get('LOCAL_JEV_PORT')
    const custom = await $.env.get('LOCAL_JEV_CONFIG')
    const path = configPath(custom, await homeDir($))
    let file: string | undefined
    if (path !== undefined && (await $.fs.exists(path))) {
      try {
        const read = await $.fs.read(path)
        if (typeof read === 'string') file = read
      } catch {
        // Unreadable: the same as no file.
      }
    }
    return choosePort({ env, file })
  } catch {
    return choosePort({})
  }
}

// One GET of the real status route. `$.http.fetch` has no timeout of its own,
// so a clock timer races it.
const probeServer = async ($: Engine, port: number): Promise<Probe> => {
  let timer: Timer | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = $.clock.after(PROBE_TIMEOUT_MS, () => resolve('timeout'))
  })
  const fetched = $.http.fetch(`http://127.0.0.1:${port}${STATUS_PATH}`).then(
    response => ({ response }),
    (error: unknown) => ({ error }),
  )
  const first = await Promise.race([fetched, timeout])
  timer?.cancel()
  if (first === 'timeout') return { state: 'down', reason: 'timeout' }
  if ('error' in first) return { state: 'down', reason: 'unreachable', detail: errorText(first.error) }
  return parseStatus(first.response.status, first.response.text)
}

// Puts a probe on the status line and toasts when the server was up and is not.
const show = ($: Engine, port: number, probe: Probe) => {
  const { health, isDrop } = transition(last, probe)
  last = health
  $.ui.status(statusLine(health))
  if (isDrop) $.ui.toast(dropToast(port))
}

const check = async ($: Engine) => {
  const { port } = await readPort($)
  let probe = await probeServer($, port)
  // A server that was just up and does not answer in time gets one more try
  // before it counts as down: a slow answer is not a stopped server.
  if (probe.state === 'down' && probe.reason === 'timeout' && last === 'up') probe = await probeServer($, port)
  show($, port, probe)
}

const agentLoaded = async ($: Engine): Promise<boolean | undefined> => {
  try {
    const ran = await $.process.run(['/bin/sh', '-c', `/bin/launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1`])
    return ran.exitCode === 0
  } catch {
    return undefined
  }
}

// Runs `local-jev serve` for the life of the session: the loop below is the
// child's life, and the module unloading ends both.
const launch = ($: Engine, shell: string, home: string): Child => {
  const started: Child = { isRunning: true, tail: '' }
  child = started
  void (async () => {
    try {
      const stream = $.process.spawn({ argv: [shell, '-ic', SERVE_COMMAND], ...(home ? { cwd: home } : {}) })
      for await (const chunk of stream) started.tail = (started.tail + chunk.text).slice(-TAIL_KEEP)
      const { code, signal } = await stream.result
      started.endedWith = signal ? `signal ${signal}` : `exit code ${code}`
    } catch (error) {
      started.endedWith = errorText(error)
    } finally {
      started.isRunning = false
    }
  })().catch(error => $.ui.log(`jev-status: ${errorText(error)}`, { to: 'debug' }))
  return started
}

// Polls until the new server answers, it dies, or the minute is up, then
// says so. A hook's budget would not last the minute, so a clock timer does
// the polling after the command has already answered.
const watchStartup = async ($: Engine, port: number, started: Child) => {
  const startedAt = await $.clock.now()
  let isBusy = false
  const timer: Timer = $.clock.every(POLL_MS, () => {
    if (isBusy) return
    isBusy = true
    void (async () => {
      const probe = await probeServer($, port)
      show($, port, probe)
      let report: { text: string; toast: string } | undefined
      if (probe.state === 'up') {
        report = { text: startedText(port, probe), toast: `local-jev is up on port ${port}` }
      } else if (!started.isRunning) {
        report = {
          text: exitedText(port, started.endedWith, tailText(started.tail)),
          toast: `local-jev did not start on port ${port}. See the transcript.`,
        }
      } else if ((await $.clock.now()) - startedAt >= STARTUP_LIMIT_MS) {
        report = {
          text: timeoutText(port, tailText(started.tail)),
          toast: `local-jev did not answer on port ${port}. See the transcript.`,
        }
      }
      if (report === undefined) return
      timer.cancel()
      $.ui.log(report.text)
      $.ui.toast(report.toast)
    })()
      .catch(error => {
        timer.cancel()
        $.ui.log(`jev-status: ${errorText(error)}`, { to: 'debug' })
      })
      .finally(() => {
        isBusy = false
      })
  })
}

// /jev-start. The three cases: already up; a login agent is installed (never
// a second server, just the command to start it); otherwise start one.
const jevStart = async ($: Engine): Promise<string> => {
  const { port, problem } = await readPort($)
  const note = problem === undefined ? '' : `\nNote: ${problem}`
  const probe = await probeServer($, port)
  show($, port, probe)
  if (probe.state === 'up') return upText(port, probe)
  if (probe.reason === 'not-local-jev') return foreignText(port, probe.detail) + note
  if (child?.isRunning) return stillRunningText(port) + note

  const home = await homeDir($)
  const plist = `${home}/Library/LaunchAgents/${LABEL}.plist`
  if (await $.fs.exists(plist)) return agentText({ port, plist, isLoaded: await agentLoaded($) }) + note

  const { shell } = await hostInfo($)
  const started = launch($, shell, home)
  void watchStartup($, port, started).catch(error => $.ui.log(`jev-status: ${errorText(error)}`, { to: 'debug' }))
  return startingText(port) + note
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'jev-start',
      description: 'Start the local-jev server if it is down',
    })
    ticker?.cancel()
    ticker = $.clock.every(CHECK_MS, () => {
      void check($).catch(error => $.ui.log(`jev-status: ${errorText(error)}`, { to: 'debug' }))
    })
    void check($).catch(error => $.ui.log(`jev-status: ${errorText(error)}`, { to: 'debug' }))
    return started
  })

  on('command.run', { command: 'jev-start' }, async $ => {
    try {
      return { text: await jevStart($) }
    } catch (error) {
      return { text: `local-jev: /jev-start failed: ${errorText(error)}` }
    }
  })
}
