import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { FINGERPRINT } from '../hooks/logic'

const CHECK = ['/bin/zsh', '-ic', 'bash scripts/check.sh 2>&1']

const FAILING = [
  '==> uv run ruff check .',
  '==> uv run pytest -q',
  'FAILED tests/test_x.py::test_y - assert 1 == 2',
  '==> failed:',
  '    uv run pytest -q',
].join('\n')

const PASSING = ['==> uv run ruff check .', '==> uv run pytest -q', '==> all checks passed'].join('\n')

const ok = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type World = {
  tree: string
  check: { exitCode: number; stdout: string } | 'cannot start'
  hasCheckScript: boolean
  isGitBroken: boolean
  checks: number
  spawns: number
  allowed: number
  clock: ReturnType<typeof mock.clock>
}

// Stands for the engine and a repo at /repo: git, the check script and the
// tool beneath the plugin.
function repo(on: On, overrides: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = {
    tree: 'tree-1',
    check: { exitCode: 1, stdout: FAILING },
    hasCheckScript: true,
    isGitBroken: false,
    checks: 0,
    spawns: 0,
    allowed: 0,
    clock,
    ...overrides,
  }
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('process.spawn', async function* (_, e) {
    world.spawns += 1
    expect(e.argv).toEqual(CHECK)
    const check = world.check === 'cannot start' ? { exitCode: 1, stdout: '' } : world.check
    // Split mid-line, as a pipe does.
    yield { stream: 'stdout' as const, text: check.stdout.slice(0, 17) }
    yield { stream: 'stdout' as const, text: check.stdout.slice(17) }
    return { value: { code: check.exitCode, signal: null } }
  })
  on('fs.exists', (_, e) => ({ value: world.hasCheckScript && e.path === '/repo/scripts/check.sh' }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('"$HOME"')) return ok('/bin/zsh\n/Users/me')
    if (argv === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (argv === `/bin/sh -c ${FINGERPRINT}`) {
      return world.isGitBroken ? { deny: 'git is gone' } : ok(`${world.tree}\n`)
    }
    if (argv === CHECK.join(' ')) {
      world.checks += 1
      if (world.check === 'cannot start') return { deny: 'spawn /bin/zsh ENOENT' }
      return ok(world.check.stdout, world.check.exitCode)
    }
    throw new Error(`unexpected command: ${argv}`)
  })
  on('tool.call', () => {
    world.allowed += 1
    return { result: {} }
  })
  return world
}

// What the model reads when the call was refused, else undefined.
async function commit(
  $: { tool: { call: (input: { tool: 'Bash'; command: string }) => Promise<unknown> } },
  command = 'git commit -m "x"',
) {
  const ran = (await $.tool.call({ tool: 'Bash', command })) as { deny?: string; isError?: boolean; text?: string }
  return ran.deny ?? (ran.isError ? ran.text : undefined)
}

test('a failing check stops the commit and says why', async ($, on) => {
  const world = repo(on)

  const refused = await commit($)

  expect(world.allowed).toBe(0)
  expect(world.checks).toBe(1)
  expect(refused).toContain('checks fail in repo')
  expect(refused).toContain('Failed: pytest')
  expect(refused).toContain('FAILED tests/test_x.py::test_y')
})

test('a passing check lets the commit through, and is reused for the same tree', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING } })

  expect(await commit($)).toBeUndefined()
  expect(await commit($, 'git -c user.name=AndresRubio commit --amend --no-edit')).toBeUndefined()

  expect(world.allowed).toBe(2)
  expect(world.checks).toBe(1)
})

test('a changed tree runs the checks again', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING } })

  await commit($)
  world.tree = 'tree-2'
  world.check = { exitCode: 1, stdout: FAILING }
  const refused = await commit($)

  expect(world.checks).toBe(2)
  expect(refused).toContain('Failed: pytest')
})

test('a failing result is reused too: no rerun until the code changes', async ($, on) => {
  const world = repo(on)

  await commit($)
  await commit($)

  expect(world.checks).toBe(1)
  expect(world.allowed).toBe(0)
})

test('commands that are not commits pass untouched', async ($, on) => {
  const world = repo(on)

  expect(await commit($, 'git status && git commit --dry-run')).toBeUndefined()
  expect(await commit($, 'ls -la')).toBeUndefined()

  expect(world.checks).toBe(0)
  expect(world.allowed).toBe(2)
})

test('a repo with no check command is not gated', async ($, on) => {
  const world = repo(on, { hasCheckScript: false })
  on('fs.read', () => {
    throw new Error('no package.json here')
  })

  expect(await commit($)).toBeUndefined()
  expect(world.checks).toBe(0)
})

test('a check that cannot start stops the commit', async ($, on) => {
  const world = repo(on, { check: 'cannot start' })

  const refused = await commit($)

  expect(world.allowed).toBe(0)
  expect(refused).toContain('could not run')
  expect(refused).toContain('ENOENT')
})

test('the band shows the failing steps, on every surface', async ($, on) => {
  repo(on)
  await commit($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'check-gate',
      component: 'AbovePrompt',
      surface,
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 120,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    })
    const line = await ui.find({ type: 'Text', text: /Checks fail/ })
    expect(line?.text).toContain('Checks fail in repo: pytest. Commits are blocked.')
    expect(await ui.find({ key: 'run:/repo' })).toBeDefined()
    await ui.unmount()
  }
})

test('a gate that breaks fails closed', async ($, on) => {
  const world = repo(on, { isGitBroken: true })

  const refused = await commit($)

  expect(world.allowed).toBe(0)
  expect(refused).toContain('the gate itself failed')
})

const TURN_END = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

const BAND = {
  plugin: 'check-gate',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

async function bandText($: { ui: { mount: (input: typeof BAND & { surface: 'desktop' }) => Promise<{ find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined>; unmount: () => Promise<void> }> } }) {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /Checks/ })
  await ui.unmount()
  return line?.text
}

test('an edit runs the checks in the background when the turn ends', async ($, on) => {
  const world = repo(on)

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.py', old_string: 'a', new_string: 'b' })
  await $.turn.complete(TURN_END)
  await world.clock.settle()

  expect(world.spawns).toBe(1)
  expect(await bandText($)).toContain('Checks fail in repo: pytest. Commits are blocked.')

  // The commit reuses the background result: no second run.
  expect(await commit($)).toContain('Failed: pytest')
  expect(world.checks).toBe(0)

  // Same tree at the next turn end: nothing runs again.
  await $.turn.complete(TURN_END)
  await world.clock.settle()
  expect(world.spawns).toBe(1)
})

test('a repo nobody has checked waits for Run now when the turn edited nothing', async ($, on) => {
  const world = repo(on)

  await $.turn.complete(TURN_END)
  await world.clock.settle()

  expect(world.spawns).toBe(0)
  expect(await bandText($)).toContain("haven't run since the last change")
})

test('a subagent turn end runs nothing', async ($, on) => {
  const world = repo(on)

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.py', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ ...TURN_END, agentId: 'a1' })
  await world.clock.settle()

  expect(world.spawns).toBe(0)
})
