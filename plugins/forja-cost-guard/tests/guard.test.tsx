import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import {
  cleanupDeleted,
  cleanupPromptEof,
  cleanupProvider,
  destroyUnconfirmed,
  forcedState,
  pricingPy,
  promptEof,
  smokeYaml,
  success,
  successState,
} from './fixtures'
import type { Fixture } from './fixtures'

// A forja checkout at /repo, its smoke recipe and the run folder forja makes.
const CONFIG = '/repo/recipes/smoke/smoke.yaml'
const RUNS = '/repo/recipes/smoke/runs'
const RUN_DIR = `${RUNS}/2026-10-30_smoke_r1`
const STATE = `${RUN_DIR}/state.json`
// The clock starts where forja's state.json says the run folder was made.
const START = Date.parse('2026-10-30T06:34:43+00:00')

const RUN = 'uv run forja run recipes/smoke/smoke.yaml --yes'
const RUNPOD_SETS = `--set train.runner.provider=runpod --set 'train.runner.gpu=["NVIDIA L4"]'`
// forja's cost line for RunPod, in the format cli.py prints.
const RUNPOD_QUOTE =
  'runpod: NVIDIA L4 at $0.44/h (RunPod Secure Cloud, highest price among the GPUs it may pick); worst case $0.44 for max_hours=1'

type BashAnswer = { result: unknown; text?: string; isError?: true }

const ok = (stdout: string): { value: ProcessRunResult } => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// What the Bash tool returns for a command that exited.
const exited = (f: Fixture): BashAnswer =>
  f.exitCode === 0
    ? { result: { stdout: f.output, stderr: '', interrupted: false }, text: f.output }
    : { isError: true, result: `Exit code ${f.exitCode}\n${f.output}`, text: `Exit code ${f.exitCode}\n${f.output}` }

// The run's state.json while it trains, and after, from forja's own file.
const stateWith = (fields: Record<string, unknown>) => JSON.stringify({ ...(JSON.parse(successState) as object), ...fields })
const RUNNING = stateWith({ status: 'running', gpu_seconds: null, est_cost_usd: null, destroy_confirmed: null })

type World = {
  files: Record<string, string>
  dirs: Record<string, string[]>
  bash: (command: string) => BashAnswer | Promise<BashAnswer>
  ran: string[]
  toasts: string[]
  // Calls the mod made on the file system and processes.
  looks: number
  isCwdBroken: boolean
  clock: ReturnType<typeof mock.clock>
  // Rows the mod appended to the conversation, as text; undefined where the
  // kit cannot record them (Claude Code before mock.session).
  appended: () => string[] | undefined
}

type Options = { permission?: 'allow' | 'deny'; store?: Record<string, unknown> }

// Stands for the engine, the forja repo and the Bash tool beneath the mod.
function repo(on: On, overrides: Partial<World> = {}, options: Options = {}): World {
  const world: World = {
    files: { [CONFIG]: smokeYaml },
    dirs: { [RUNS]: [] },
    bash: () => exited(success),
    ran: [],
    toasts: [],
    looks: 0,
    isCwdBroken: false,
    clock: mock.clock(on, { now: START }),
    appended: () => undefined,
    ...overrides,
  }
  if (typeof mock.session === 'function') {
    const session = mock.session(on)
    world.appended = () => session.appended().map(row => JSON.stringify(row.message.content))
  }
  mock.store(on, options.store)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => (world.isCwdBroken ? { deny: 'the session folder is gone' } : { value: '/repo' }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', (_, e) => {
    world.looks += 1
    const text = world.files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.exists', (_, e) => {
    world.looks += 1
    return { value: e.path in world.files || e.path in world.dirs }
  })
  on('fs.stat', (_, e) => {
    world.looks += 1
    const text = world.files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_, e) => {
    world.looks += 1
    const names = world.dirs[e.path]
    return names === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: names.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => {
    world.looks += 1
    const argv = e.argv.join(' ')
    if (argv === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (e.argv[0] === '/bin/sh' && argv.includes('$HOME')) return ok('/Users/me')
    throw new Error(`unexpected command: ${argv}`)
  })
  // The engine's own verdict: the session allows Bash.
  on('tool.check', () => ({ decision: 'allow' }))
  if (options.permission !== undefined) {
    const behavior = options.permission
    on('classic.PermissionRequest', () => ({ decision: { behavior } }))
  }
  on('tool.call', async (_, e) => {
    const command = (e as { command?: unknown }).command
    world.ran.push(String(command))
    return world.bash(String(command))
  })
  // What the engine draws above the prompt when the mod has nothing.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return world
}

const BAND = {
  plugin: 'forja-cost-guard',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Mounted = {
  find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined>
  press: (q: { key: string }) => Promise<unknown>
  unmount: () => Promise<void>
}
type Mountable = { ui: { mount: (input: typeof BAND & { surface: 'terminal' | 'desktop' }) => Promise<Mounted> } }

// The band's lines that match, on each surface; the same on both.
async function band($: Mountable, pattern: RegExp): Promise<string | undefined> {
  const seen: (string | undefined)[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    seen.push((await ui.find({ type: 'Text', text: pattern }))?.text)
    await ui.unmount()
  }
  expect(seen[0]).toBe(seen[1])
  return seen[0]
}

type Called = { deny?: string; isError?: boolean; text?: string; context?: readonly string[] }
type Callable = { tool: { call: (input: { tool: 'Bash'; command: string; run_in_background?: boolean }) => Promise<unknown> } }

async function bash($: Callable, command: string, isBackground = false): Promise<Called> {
  return (await $.tool.call({ tool: 'Bash', command, ...(isBackground ? { run_in_background: true } : {}) })) as Called
}

test('forja run --yes asks the person, with the config, GPU, price and maximum cost', async ($, on) => {
  repo(on)

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: RUN } })

  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('`forja run --yes` skips forja\'s own cost question')
  expect(verdict.reason).toContain(
    'Config recipes/smoke/smoke.yaml: modal L4 at $0.80/h (Modal list price as of 2026-10-05, GPU only); maximum cost $0.80 for max_hours=1.',
  )
})

test('a run without --yes, and every other command, keeps the engine verdict', async ($, on) => {
  const world = repo(on)

  for (const command of ['uv run forja run recipes/smoke/smoke.yaml', 'forja validate recipes/smoke/smoke.yaml', 'forja --help', 'ls -la', 'git status']) {
    expect((await $.tool.check({ tool: 'Bash', input: { command } })).decision).toBe('allow')
  }
  expect(world.looks).toBe(0)
})

test('the price comes from the repo own pricing.py', async ($, on) => {
  repo(on, { files: { [CONFIG]: smokeYaml, '/repo/src/forja/pricing.py': pricingPy.replace('"L4": 0.80', '"L4": 0.85') } })

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: RUN } })

  expect(verdict.reason).toContain('modal L4 at $0.85/h')
  expect(verdict.reason).toContain('maximum cost $0.85')
})

test('with nobody to approve, the run does not start', async ($, on) => {
  const world = repo(on)

  const ran = await bash($, RUN)

  expect(world.ran).toEqual([])
  const said = [ran.deny, ran.text, ...(ran.context ?? [])].join('\n')
  expect(said).toContain('modal L4 at $0.80/h (Modal list price as of 2026-10-05, GPU only); maximum cost $0.80')
  expect(said).toContain('It was not approved')
  expect(await band($, /forja/)).toBeUndefined()
})

test('a refusal stops the run', async ($, on) => {
  const world = repo(on, {}, { permission: 'deny' })

  const ran = await bash($, RUN)

  expect(world.ran).toEqual([])
  expect([ran.deny, ...(ran.context ?? [])].join('\n')).toContain('Do not start it another way')
})

test('once approved, the band shows the running cost, then goes when the run ends', async ($, on) => {
  const world: World = repo(
    on,
    {
      bash: async () => {
        // forja makes the run folder and its state.json, then trains for 30 minutes.
        world.dirs[RUNS] = ['2026-10-30_smoke_r1']
        world.files[STATE] = RUNNING
        await world.clock.sleep(30 * 60_000)
        world.files[STATE] = stateWith({ gpu_seconds: 1800, est_cost_usd: 0.4 })
        return exited(success)
      },
    },
    { permission: 'allow' },
  )

  const call = bash($, RUN)
  await world.clock.advance(10 * 60_000)

  expect(world.ran).toEqual([RUN])
  expect(await band($, /forja run/)).toBe('forja run smoke.yaml: modal L4 · 10m 00s elapsed · $0.80/h · $0.13 so far · max $0.80')

  await world.clock.advance(20 * 60_000)
  const ran = await call

  expect(ran.context).toBeUndefined()
  expect(await band($, /forja/)).toBeUndefined()
  expect(world.toasts).toEqual(['forja run smoke.yaml ended (exit 0), about $0.40.'])
})

test('exit 3 leaves a reminder, a toast and a note; forja cleanup clears it', async ($, on) => {
  const world = repo(on, { bash: command => (command.includes('cleanup') ? exited(cleanupProvider) : exited(destroyUnconfirmed)) }, { permission: 'allow' })
  world.files[STATE] = stateWith({ status: 'verified', destroy_confirmed: false })

  const ran = await bash($, RUN)

  const note = ran.context?.join('\n') ?? ''
  expect(note).toContain('remote resources may still exist on modal (forja could not confirm the delete)')
  expect(note).toContain('run `forja cleanup --provider modal --yes`')
  expect(await band($, /Remote forja/)).toBe(
    'Remote forja resources may still exist on modal (forja could not confirm the delete). Run `forja cleanup --provider modal`. ',
  )

  const cleaned = await bash($, 'uv run forja cleanup --provider modal --yes')

  expect(cleaned.context).toBeUndefined()
  expect(await band($, /forja/)).toBeUndefined()
})

test('a background run is followed through its output file to its end', async ($, on) => {
  const OUT = '/tmp/tasks/b1.output'
  const world: World = repo(
    on,
    {
      bash: () => {
        world.dirs[RUNS] = ['2026-10-30_smoke_r1']
        world.files[STATE] = RUNNING
        // What forja has printed so far: the data report, its quote, the create line.
        world.files[OUT] = success.output.slice(0, success.output.indexOf('fake job log line'))
        return {
          result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
          text: `Command running in background with ID: b1. Output is being written to: ${OUT}. You will be notified when it completes.`,
        }
      },
    },
    { permission: 'allow' },
  )

  const ran = await bash($, RUN, true)
  expect(ran.context).toBeUndefined()

  await world.clock.advance(5 * 60_000)
  expect(await band($, /forja run/)).toBe('forja run smoke.yaml: modal L4 · 5m 00s elapsed · $0.80/h · $0.07 so far · max $0.80')

  world.files[OUT] = `${destroyUnconfirmed.output}\n[exited with code 3]\n`
  world.files[STATE] = stateWith({ status: 'verified', destroy_confirmed: false })
  await world.clock.advance(5_000)

  expect(await band($, /forja run/)).toBeUndefined()
  expect(await band($, /Remote forja/)).toContain('may still exist on modal')
  expect(world.toasts).toEqual(['forja: remote resources may still exist on modal. Run forja cleanup --provider modal.'])
  const appended = world.appended()
  if (appended !== undefined) {
    expect(appended.some(text => text.includes('the background forja run for smoke.yaml ended with exit code 3'))).toBe(true)
  }
})

test('an interrupted run after its run folder exists leaves a reminder', async ($, on) => {
  const world: World = repo(
    on,
    {
      bash: () => {
        world.dirs[RUNS] = ['2026-10-30_smoke_r1']
        world.files[STATE] = forcedState
        return { result: { stdout: 'creating remote resources on modal; this can take a few minutes', stderr: '', interrupted: true } }
      },
    },
    { permission: 'allow' },
  )

  const ran = await bash($, RUN)

  expect(ran.context?.join('\n')).toContain('remote resources may still exist on modal (the run was interrupted)')
  expect(await band($, /Remote forja/)).toContain('Run `forja cleanup --provider modal`')
})

test('forja own question under the Bash tool: the note explains, and its quote is kept for the confirmation', async ($, on) => {
  const runpodAborted = promptEof.output
    .replace(/^modal: .*$/m, RUNPOD_QUOTE)
    .replace('worst case $0.80)?', 'worst case $0.44)?')
  const world = repo(on, {
    bash: command => (command.includes('runpod') ? exited({ exitCode: 2, output: runpodAborted }) : exited(promptEof)),
  })

  const ran = await bash($, 'uv run forja run recipes/smoke/smoke.yaml')
  const note = ran.context?.join('\n') ?? ''
  expect(note).toContain('forja read that as no and stopped with exit 2. Nothing was created.')
  expect(note).toContain('Its quote: modal L4 at $0.80/h')
  expect(note).toContain('run the same command with --yes, with run_in_background set to true')

  const before = await $.tool.check({ tool: 'Bash', input: { command: `${RUN} ${RUNPOD_SETS}` } })
  expect(before.reason).toContain('Price not shown: RunPod gives the price when forja starts')

  await bash($, `uv run forja run recipes/smoke/smoke.yaml ${RUNPOD_SETS}`)
  const after = await $.tool.check({ tool: 'Bash', input: { command: `${RUN} ${RUNPOD_SETS}` } })
  expect(after.reason).toContain('runpod NVIDIA L4 at $0.44/h')
  expect(await band($, /forja/)).toBeUndefined()
  expect(world.toasts).toEqual([])
})

test('a reminder from an earlier session shows, and Dismiss clears it', async ($, on) => {
  const world = repo(on, {}, { store: { 'reminders-1': { modal: { key: 'modal', provider: 'modal', why: 'forja was forced to exit', since: 1 } } } })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await world.clock.settle()

  expect(await band($, /Remote forja/)).toContain('on modal (forja was forced to exit)')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'dismiss:modal' })
  await ui.unmount()
  expect(await band($, /Remote forja/)).toBeUndefined()
})

test('a cleanup that skipped the provider keeps the reminder and says why', async ($, on) => {
  const world = repo(on, { bash: () => exited(cleanupDeleted) }, { store: { 'reminders-1': { runpod: { key: 'runpod', provider: 'runpod', why: 'x', since: 1 } } } })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await world.clock.settle()

  const cleaned = await bash($, 'forja cleanup --yes')

  expect(cleaned.context?.join('\n')).toContain('runpod was skipped (no credentials in this environment)')
  expect(await band($, /Remote forja/)).toContain('on runpod')
})

test('forja cleanup without --yes under the Bash tool: the note says to add it', async ($, on) => {
  repo(on, { bash: () => exited(cleanupPromptEof) })

  const cleaned = await bash($, 'forja cleanup')

  expect(cleaned.context?.join('\n')).toContain('Run `forja cleanup --yes`')
  // It listed forja-1a2b3c4d on modal and stopped: that one is still there.
  expect(await band($, /Remote forja/)).toContain('on modal (forja cleanup stopped before deleting them)')
})

test('the guard fails closed when it cannot work out the run', async ($, on) => {
  repo(on, { isCwdBroken: true })

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: RUN } })
  expect(verdict.decision).toBe('deny')
  expect(verdict.reason).toContain('the cost check itself failed')

  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('allow')
})

test('unrelated commands pass untouched', async ($, on) => {
  const world = repo(on, { bash: () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }) })

  for (const command of ['ls -la', 'git status', 'npm test', 'echo forja run x --yes']) {
    expect((await bash($, command)).context).toBeUndefined()
  }
  expect(world.looks).toBe(0)
  expect(world.toasts).toEqual([])
  expect(await band($, /forja/)).toBeUndefined()
  expect(await band($, /engine/)).toBe('engine')
})
