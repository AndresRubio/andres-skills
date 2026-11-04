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

const NOT_A_REPO = 'fatal: not a git repository (or any of the parent directories): .git'

const ok = (stdout: string, exitCode = 0, stderr = ''): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type World = {
  tree: string
  check: { exitCode: number; stdout: string } | 'cannot start'
  hasCheckScript: boolean
  isGitBroken: boolean
  // Where the Bash tool is, which `$.session.cwd()` reports. `broken` makes the call reject.
  bashDir: string | 'broken'
  // What `git rev-parse --show-toplevel` does: finds /repo, exits 128, or never starts.
  revParse: 'found' | 'not a repo' | 'cannot start'
  // A check that waits for `release()` before it ends, to look at the gate mid-run.
  hold: boolean
  release: () => void
  spawns: number
  // The folder each background check ran in.
  spawnedIn: (string | undefined)[]
  // The prompts the gate submitted when a run a commit was refused on ended.
  sent: string[]
  // The engine refuses every prompt, as it does while a Stop stands.
  dropPrompts: boolean
  toasts: string[]
  allowed: number
  clock: ReturnType<typeof mock.clock>
}

// Stands for the engine, a repo at /repo and a second one at /other whose
// check always fails: git, the check script and the tool beneath the plugin.
function repo(on: On, overrides: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: 1_000 })
  const world: World = {
    tree: 'tree-1',
    check: { exitCode: 1, stdout: FAILING },
    hasCheckScript: true,
    isGitBroken: false,
    bashDir: '/repo',
    revParse: 'found',
    hold: false,
    release: () => undefined,
    spawns: 0,
    spawnedIn: [],
    sent: [],
    dropPrompts: false,
    toasts: [],
    allowed: 0,
    clock,
    ...overrides,
  }
  mock.store(on)
  on('session.cwd', () => (world.bashDir === 'broken' ? { deny: 'no folder' } : { value: world.bashDir }))
  on('prompt.submit', (_, e) => {
    if (world.dropPrompts) return { drop: 'a Stop stands' }
    world.sent.push(e.text)
    return { text: e.text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    world.toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('process.spawn', async function* (_, e) {
    world.spawns += 1
    world.spawnedIn.push(e.cwd)
    expect(e.argv).toEqual(CHECK)
    if (world.hold) await new Promise<void>(resolve => (world.release = resolve))
    if (world.check === 'cannot start') return { deny: 'spawn /bin/zsh ENOENT' }
    const check = e.cwd === '/other' ? { exitCode: 1, stdout: FAILING } : world.check
    // Split mid-line, as a pipe does.
    yield { stream: 'stdout' as const, text: check.stdout.slice(0, 17) }
    yield { stream: 'stdout' as const, text: check.stdout.slice(17) }
    return { value: { code: check.exitCode, signal: null } }
  })
  on('fs.exists', (_, e) => ({
    value: world.hasCheckScript && ['/repo/scripts/check.sh', '/other/scripts/check.sh'].includes(e.path),
  }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('"$HOME"')) return ok('/bin/zsh\n/Users/me')
    if (argv === 'git rev-parse --show-toplevel') {
      if (world.revParse === 'cannot start') return { deny: 'spawn git ENOENT' }
      if (world.revParse === 'not a repo') return ok('', 128, NOT_A_REPO)
      // With no folder named this answers /repo, so the gate has to name where
      // Bash is. The real default follows Bash too on 2.1.309 (the PR has the
      // runs); the gate names the folder so it doesn't lean on that.
      return ok(e.init?.cwd?.startsWith('/other') ? '/other\n' : '/repo\n')
    }
    if (argv === `/bin/sh -c ${FINGERPRINT}`) {
      return world.isGitBroken ? { deny: 'git is gone' } : ok(`${world.tree}\n`)
    }
    throw new Error(`unexpected command: ${argv}`)
  })
  on('tool.call', () => {
    world.allowed += 1
    return { result: {} }
  })
  return world
}

type Caller = { tool: { call: (input: { tool: 'Bash'; command: string }) => Promise<unknown> } }

// What the model reads when the call was refused, else undefined.
async function commit($: Caller, command = 'git commit -m "x"') {
  const ran = (await $.tool.call({ tool: 'Bash', command })) as { deny?: string; isError?: boolean; text?: string }
  return ran.deny ?? (ran.isError ? ran.text : undefined)
}

// A commit on a tree nobody has checked: refused while the checks start in the
// background, which then run to their end.
async function firstCommit($: Caller, world: World, command?: string) {
  const refused = await commit($, command)
  expect(refused).toContain('have no result for this tree yet')
  expect(refused).toContain('running now in the background: bash scripts/check.sh')
  await world.clock.settle()
  return refused
}

test('a commit with no result starts the checks and is refused; the next one reads their failure', async ($, on) => {
  const world = repo(on)

  const pending = await commit($)

  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(1)
  expect(pending).toContain('have no result for this tree yet')
  expect(pending).toContain('gets a message when they finish')
  expect(pending).toContain('do not edit files in repo until they report')

  await world.clock.settle()
  expect(world.sent).toHaveLength(1)
  expect(world.sent[0]).toContain('Check gate: Checks fail in repo: pytest')
  expect(world.sent[0]).toContain('commit again')

  const refused = await commit($)
  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(1)
  expect(refused).toContain('checks fail in repo')
  expect(refused).toContain('Failed: pytest')
  expect(refused).toContain('FAILED tests/test_x.py::test_y')
})

test('a passing check reports back, lets the commit through, and is reused for the same tree', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING } })

  await firstCommit($, world)

  expect(world.sent).toHaveLength(1)
  expect(world.sent[0]).toContain('Check gate: the checks passed in repo')
  expect(world.sent[0]).toContain('Run the commit again')
  expect(await commit($)).toBeUndefined()
  expect(await commit($, 'git -c user.name=AndresRubio commit --amend --no-edit')).toBeUndefined()

  expect(world.allowed).toBe(2)
  expect(world.spawns).toBe(1)
})

test('a commit while the checks run is refused without a second run', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING }, hold: true })

  await commit($)
  const again = await commit($)

  expect(again).toContain('still running in the background')
  expect(world.spawns).toBe(1)
  expect(world.allowed).toBe(0)

  world.release()
  await world.clock.settle()
  expect(await commit($)).toBeUndefined()
  expect(world.spawns).toBe(1)
})

test('a commit refused on a run a turn end started is told its outcome too', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING }, hold: true })

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.py', old_string: 'a', new_string: 'b' })
  await $.turn.complete(TURN_END)
  await world.clock.settle()
  expect(world.spawns).toBe(1)

  const refused = await commit($)
  expect(refused).toContain('still running in the background')
  expect(world.spawns).toBe(1)

  world.release()
  await world.clock.settle()
  expect(world.sent).toHaveLength(1)
  expect(world.sent[0]).toContain('the checks passed in repo')
  expect(await commit($)).toBeUndefined()
})

test('a run that replaces the one a commit was refused on reports in its place', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING }, hold: true })

  await commit($)
  // The tree changes under the run, and the next turn end starts a fresh one.
  world.tree = 'tree-2'
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.py', old_string: 'a', new_string: 'b' })
  await $.turn.complete(TURN_END)
  await world.clock.settle()
  expect(world.spawns).toBe(2)

  world.release()
  await world.clock.settle()
  expect(world.sent).toHaveLength(1)
  expect(world.sent[0]).toContain('the checks passed in repo')
  expect(await commit($)).toBeUndefined()
})

test('a report the engine drops is toasted instead', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING }, dropPrompts: true })

  await firstCommit($, world)

  expect(world.sent).toEqual([])
  expect(world.toasts.join('\n')).toContain('the checks passed in repo')
  expect(await commit($)).toBeUndefined()
})

test('a changed tree runs the checks again', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING } })

  await firstCommit($, world)
  expect(await commit($)).toBeUndefined()

  world.tree = 'tree-2'
  world.check = { exitCode: 1, stdout: FAILING }
  await firstCommit($, world)
  const refused = await commit($)

  expect(world.spawns).toBe(2)
  expect(refused).toContain('Failed: pytest')
})

test('a failing result is reused too: no rerun until the code changes', async ($, on) => {
  const world = repo(on)

  await firstCommit($, world)
  await commit($)
  await commit($)

  expect(world.spawns).toBe(1)
  expect(world.allowed).toBe(0)
})

test('commands that are not commits pass untouched', async ($, on) => {
  const world = repo(on)

  expect(await commit($, 'git status && git commit --dry-run')).toBeUndefined()
  expect(await commit($, 'ls -la')).toBeUndefined()

  expect(world.spawns).toBe(0)
  expect(world.allowed).toBe(2)
})

test('a repo with no check command is not gated', async ($, on) => {
  const world = repo(on, { hasCheckScript: false })
  on('fs.read', () => {
    throw new Error('no package.json here')
  })

  expect(await commit($)).toBeUndefined()
  expect(world.spawns).toBe(0)
})

test('a check that cannot start is reported, and the commit stays stopped', async ($, on) => {
  const world = repo(on, { check: 'cannot start' })

  await firstCommit($, world)

  expect(world.allowed).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /run the checks/ })
  await ui.unmount()
  expect(line?.text).toContain("Couldn't run the checks in repo")
  expect(line?.text).toContain('ENOENT')
  expect(world.sent).toHaveLength(1)
  expect(world.sent[0]).toContain('ENOENT')
  expect(world.sent[0]).toContain('commit again')
})

test('the band shows the failing steps, on every surface', async ($, on) => {
  const world = repo(on)
  await firstCommit($, world)

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

test('a commit in a folder git does not know as a repo is stopped', async ($, on) => {
  const world = repo(on, { revParse: 'not a repo' })

  const refused = await commit($, 'git -C /tmp/notes commit -m "x"')

  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(0)
  expect(refused).toContain("couldn't tell which git repository")
  expect(refused).toContain('in /tmp/notes failed: fatal: not a git repository')
  expect(refused).toContain('git -C /path/to/repo commit')
})

test('a git that cannot start stops the commit', async ($, on) => {
  const world = repo(on, { revParse: 'cannot start' })

  const refused = await commit($)

  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(0)
  expect(refused).toContain("couldn't tell which git repository")
  expect(refused).toContain("in the session's folder failed")
  expect(refused).toContain('ENOENT')
})

test('a bare commit after a cd is gated by the repo Bash moved to', async ($, on) => {
  // /repo's check passes and /other's fails, so the wrong repo's check would let this through.
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING }, bashDir: '/other' })

  await firstCommit($, world)
  const refused = await commit($)

  expect(world.allowed).toBe(0)
  expect(world.spawnedIn).toEqual(['/other'])
  expect(refused).toContain('checks fail in other')
})

test('a folder the command names wins over where Bash is', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING }, bashDir: '/other' })

  await firstCommit($, world, 'git -C /repo commit -m "x"')
  expect(await commit($, 'git -C /repo commit -m "x"')).toBeUndefined()

  expect(world.allowed).toBe(1)
  expect(world.spawnedIn).toEqual(['/repo'])
})

test('a Bash folder the gate cannot read stops the commit', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING }, bashDir: 'broken' })

  const refused = await commit($)

  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(0)
  expect(refused).toContain('the gate itself failed')
})

test('a commit the command moves to another repo is gated by that repo', async ($, on) => {
  // /repo's check passes and /other's fails, so the wrong repo's check would let these through.
  const commands = [
    'pushd /other && git commit -m "x"',
    'if cd /other; then git commit -m "x"; fi',
    'cd /other && cd sub && git commit -m "x"',
    'S=/other; cd "$S" && git commit -m "x"',
    'bash -c "cd /other && git commit -m x"',
    'X="$(cd /other && git commit -m x)"',
    'x=$((1<<2))\ncd /other && git commit -m x',
    "echo $'it\\'s'; cd /other && git commit -m x",
  ]
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING } })

  await firstCommit($, world, commands[0])
  for (const command of commands) {
    const refused = await commit($, command)
    expect(refused).toBeDefined()
    expect(refused).toContain('checks fail in other')
  }

  expect(world.allowed).toBe(0)
  // The first run's result is reused for the same repo and tree.
  expect(world.spawnedIn).toEqual(['/other'])
})

test('a commit the gate cannot place is stopped, and told how to name the repo', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING } })

  const refused = await commit($, 'GIT_DIR=/other/.git git commit -m "x"')

  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(0)
  expect(refused).toBeDefined()
  expect(refused).toContain("couldn't tell which git repository it lands in")
  expect(refused).toContain('GIT_DIR')
  expect(refused).toContain('git -C /path/to/repo commit')
})

test('git --git-dir with a separate value is seen as a commit', async ($, on) => {
  const world = repo(on, { check: { exitCode: 0, stdout: PASSING } })

  const refused = await commit($, 'git --git-dir /other/.git commit -m "x"')

  expect(world.allowed).toBe(0)
  expect(refused).toBeDefined()
  expect(refused).toContain('--git-dir')
})

test('a commit split across lines is still gated', async ($, on) => {
  const world = repo(on)

  await firstCommit($, world, 'git -c a=b \\\n  commit -m "x"')

  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(1)
})

test('a commit at the start of a nested shell string is gated', async ($, on) => {
  const world = repo(on)

  await firstCommit($, world, "bash -c 'git commit -m x'")

  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(1)
})

test('a commit whose message mentions --dry-run is gated', async ($, on) => {
  const world = repo(on)

  await firstCommit($, world, 'git commit -m "add --dry-run flag"')

  expect(world.allowed).toBe(0)
  expect(world.spawns).toBe(1)
})

test('text around a commit never makes it a dry run', async ($, on) => {
  const world = repo(on)
  const commands = [
    "bash -c 'true; git commit -m x'; echo 'see --dry-run here'",
    `git commit -m "$(cat <<'EOF'\n1) see "a --dry-run b"\nEOF\n)"`,
    'bash -c "git commit -m \\"a --dry-run b\\""',
  ]

  await firstCommit($, world, commands[0])
  for (const command of commands) {
    const refused = await commit($, command)
    expect(refused).toBeDefined()
    expect(refused).toContain('checks fail in repo')
  }

  expect(world.allowed).toBe(0)
})

test('a dry run is not gated', async ($, on) => {
  const world = repo(on)

  expect(await commit($, 'git commit -m x --dry-run')).toBeUndefined()

  expect(world.allowed).toBe(1)
  expect(world.spawns).toBe(0)
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
  // Only a run a commit started reports to the session.
  expect(world.sent).toEqual([])

  // The commit reuses the background result: no second run.
  expect(await commit($)).toContain('Failed: pytest')
  expect(world.spawns).toBe(1)

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
