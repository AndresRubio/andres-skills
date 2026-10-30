import { expect, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { GATE_COMMAND, GMAIL_READ_ACTIONS, GMAIL_WRITE_ACTIONS } from '../hooks/logic'

// The real output of the gate on the ai-digest repo (exit 0), and of a run
// on a copy of its site/ with a made-up address added to a daily page (exit 1).
const PASSING = `check_no_mailbox_links             PASS
check_anchors_resolve              PASS
check_flat_structure               PASS
check_index_counts                 PASS
check_lead_length                  PASS
check_lead_counts                  PASS
check_story_link_state             PASS
check_timeline_order               PASS
check_no_wall_of_text              PASS
check_no_legacy_prose              PASS
check_sidebar_consistency          PASS

11 topic page(s) checked structurally, 118 published page(s) screened for mailbox identifiers, 0 failure(s)
`

const FAILING = `check_no_mailbox_links             FAIL (1)
check_anchors_resolve              PASS
check_flat_structure               PASS
check_index_counts                 PASS
check_lead_length                  PASS
check_lead_counts                  PASS
check_story_link_state             PASS
check_timeline_order               PASS
check_no_wall_of_text              PASS
check_no_legacy_prose              PASS
check_sidebar_consistency          PASS
  site/daily/2026-05-28.html:47 mailbox identifier in published page

11 topic page(s) checked structurally, 118 published page(s) screened for mailbox identifiers, 1 failure(s)
`

const AI = '/Users/me/ai-digest'
const WORKTREE = '/Users/me/wt/feature'
const FORK = '/Users/me/fork/ai-digest'
const OTHER = '/Users/me/other'
const SCRATCH = '/tmp/scratch'
const SCRIPT = 'digest-routine/check-structure.py'

const ok = (stdout: string, exitCode = 0, stderr = ''): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type World = {
  cwd: string
  exists: Set<string>
  // Symbolic links: path to where it leads.
  links: Record<string, string>
  repos: string[]
  gitError?: string
  gate: { exitCode: number; stdout: string } | 'cannot start'
  // python3 is not found by /bin/sh (exit 127); 'everywhere' also fails the user's shell.
  isPythonMissing?: boolean | 'everywhere'
  allowed: number
  gitCalls: number
  statCalls: number
  gateRuns: { cwd?: string }[]
  shellRuns: number
  toasts: string[]
}

// Stands for the engine and a disk: ai-digest, a worktree of it, a fork that
// only shares its name, another repo and a folder outside any repo.
function disk(on: On, overrides: Partial<World> = {}): World {
  const world: World = {
    cwd: AI,
    exists: new Set([
      '/', '/Users', '/Users/me', '/tmp', SCRATCH, `${SCRATCH}/site`,
      AI, `${AI}/site`, `${AI}/site/topics`, `${AI}/docs`, `${AI}/digest-routine`, `${AI}/${SCRIPT}`,
      `${AI}/docs/link.html`, `${AI}/site/index.html`,
      '/Users/me/wt', WORKTREE, `${WORKTREE}/site`, `${WORKTREE}/${SCRIPT}`,
      '/Users/me/fork', FORK, `${FORK}/site`,
      OTHER, `${OTHER}/site`, `${OTHER}/site/x`,
    ]),
    links: { [`${AI}/docs/link.html`]: `${AI}/site/index.html` },
    repos: [AI, WORKTREE, FORK, OTHER],
    gate: { exitCode: 0, stdout: PASSING },
    allowed: 0,
    gitCalls: 0,
    statCalls: 0,
    gateRuns: [],
    shellRuns: 0,
    toasts: [],
    ...overrides,
  }
  const gate = () => {
    if (world.gate === 'cannot start') return { deny: 'spawn /bin/sh ENOENT' }
    return ok(world.gate.stdout, world.gate.exitCode)
  }
  on('session.cwd', () => ({ value: world.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: world.exists.has(e.path) }))
  on('fs.stat', (_, e) => {
    world.statCalls += 1
    if (!world.exists.has(e.path)) return { deny: 'ENOENT' }
    const realPath = world.links[e.path]
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: realPath !== undefined, realPath: realPath ?? e.path } }
  })
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    const cwd = e.init?.cwd
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('"$HOME"')) return ok('/bin/zsh\n/Users/me')
    if (argv === 'git rev-parse --show-toplevel --show-prefix') {
      world.gitCalls += 1
      if (cwd === undefined || !world.exists.has(cwd)) return { deny: `spawn git ENOENT (cwd ${cwd})` }
      if (world.gitError !== undefined) return ok('', 128, world.gitError)
      const root = world.repos.find(repo => cwd === repo || cwd.startsWith(`${repo}/`))
      if (root === undefined) return ok('', 128, 'fatal: not a git repository (or any of the parent directories): .git')
      const inside = cwd.slice(root.length + 1)
      return ok(`${root}\n${inside === '' ? '' : `${inside}/`}\n`)
    }
    if (argv === `/bin/sh -c ${GATE_COMMAND}`) {
      world.gateRuns.push({ cwd })
      return world.isPythonMissing ? ok('sh: python3: command not found', 127) : gate()
    }
    if (argv === `/bin/zsh -ic ${GATE_COMMAND}`) {
      world.shellRuns += 1
      return world.isPythonMissing === 'everywhere' ? ok('zsh: command not found: python3', 127) : gate()
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
async function call(
  $: { tool: { call: (input: never) => Promise<unknown> } },
  input: { tool: string; [key: string]: unknown },
) {
  const ran = (await $.tool.call(input as never)) as { deny?: string; isError?: boolean; text?: string }
  return ran.deny ?? (ran.isError ? ran.text : undefined)
}

const ADDRESS = 'jane.doe@gmail.com'
const PAGE = `<p>fine</p>\n<a href="mailto:${ADDRESS}">write</a>\n`

// ---------------------------------------------------------------------------
// 1. site/ writes
// ---------------------------------------------------------------------------

test('a Write under site/ with an address is refused, naming pattern and line only', async ($, on) => {
  const world = disk(on)

  const refused = await call($, { tool: 'Write', file_path: `${AI}/site/topics/new.html`, content: PAGE })

  expect(world.allowed).toBe(0)
  expect(refused).toContain('site/topics/new.html')
  expect(refused).toContain('line 2 (@gmail.com)')
  expect(refused).not.toContain('jane')
  expect(refused).not.toContain(ADDRESS)
  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]).toContain('site/topics/new.html')
  expect(world.toasts[0]).not.toContain('jane')
})

test('clean content passes without a call to git or the disk', async ($, on) => {
  const world = disk(on)

  expect(await call($, { tool: 'Write', file_path: `${AI}/site/index.html`, content: '<p>TLDR AI (Sep 11)</p>' })).toBeUndefined()
  expect(await call($, { tool: 'Edit', file_path: `${AI}/site/index.html`, old_string: 'a', new_string: 'b' })).toBeUndefined()

  expect(world.allowed).toBe(2)
  expect(world.gitCalls).toBe(0)
  expect(world.statCalls).toBe(0)
  expect(world.toasts).toEqual([])
})

test('an Edit is judged by what it writes, not by what it removes', async ($, on) => {
  const world = disk(on)
  const file_path = `${AI}/site/topics/agents.html`

  const refused = await call($, {
    tool: 'Edit',
    file_path,
    old_string: 'old',
    new_string: '[thread](https://mail.google.com/mail/u/0/#inbox/abc)',
  })
  expect(refused).toContain('line 1 (mail.google.com)')
  expect(refused).toContain('Edit of site/topics/agents.html')

  // Taking an address out is what the project wants.
  expect(await call($, { tool: 'Edit', file_path, old_string: ADDRESS, new_string: 'TLDR AI (Sep 11)' })).toBeUndefined()
  expect(world.allowed).toBe(1)
})

test('a NotebookEdit under site/ is refused too', async ($, on) => {
  const world = disk(on)

  const refused = await call($, {
    tool: 'NotebookEdit',
    notebook_path: `${AI}/site/n.ipynb`,
    new_source: `to = "${ADDRESS}"`,
  })

  expect(refused).toContain('NotebookEdit of site/n.ipynb')
  expect(refused).toContain('line 1 (@gmail.com)')
  expect(world.allowed).toBe(0)
})

test('encoded and mixed-case forms are refused', async ($, on) => {
  const world = disk(on)
  for (const content of ['jane%40gmail.com', 'JANE@GMAIL.COM', 'jane&#64;gmail.com', 'https%3A%2F%2Fmail.google.com%2F']) {
    expect(await call($, { tool: 'Write', file_path: `${AI}/site/a.html`, content })).toContain('refused')
  }
  expect(world.allowed).toBe(0)
})

test('text that only looks like an address passes', async ($, on) => {
  const world = disk(on)
  for (const content of ['jane@gmail.company', 'webmail.google.com', 'gmail.com is a service', 'jane@example.com']) {
    expect(await call($, { tool: 'Write', file_path: `${AI}/site/a.html`, content })).toBeUndefined()
  }
  expect(world.allowed).toBe(4)
})

test('outside site/ the same text passes, even inside ai-digest', async ($, on) => {
  const world = disk(on)
  for (const file_path of [`${AI}/docs/note.md`, `${AI}/digest-routine/README.md`, `${AI}/README.md`, `${AI}/docs/site/x.md`]) {
    expect(await call($, { tool: 'Write', file_path, content: PAGE })).toBeUndefined()
  }
  expect(world.allowed).toBe(4)
})

test('a file in folders that do not exist yet is judged by the nearest one that does', async ($, on) => {
  const world = disk(on)

  const refused = await call($, { tool: 'Write', file_path: `${AI}/site/archive/2026/10/p.html`, content: PAGE })

  expect(refused).toContain('site/archive/2026/10/p.html')
  expect(world.allowed).toBe(0)
})

test('it stays inert in other repos and outside any repo', async ($, on) => {
  const world = disk(on)
  expect(await call($, { tool: 'Write', file_path: `${OTHER}/site/x/y.html`, content: PAGE })).toBeUndefined()
  expect(await call($, { tool: 'Write', file_path: `${OTHER}/site/new/a.html`, content: PAGE })).toBeUndefined()
  expect(await call($, { tool: 'Write', file_path: `${SCRATCH}/site/a.html`, content: PAGE })).toBeUndefined()
  expect(world.allowed).toBe(3)
  expect(world.toasts).toEqual([])
})

test('a worktree is found by the gate script, a fork by its folder name', async ($, on) => {
  const world = disk(on)

  expect(await call($, { tool: 'Write', file_path: `${WORKTREE}/site/a.html`, content: PAGE })).toContain('site/a.html')
  expect(await call($, { tool: 'Write', file_path: `${FORK}/site/a.html`, content: PAGE })).toContain('site/a.html')
  expect(world.allowed).toBe(0)
})

test('the site folder is matched without case, and through .. and relative paths', async ($, on) => {
  const world = disk(on)

  expect(await call($, { tool: 'Write', file_path: `${AI}/Site/index.html`, content: PAGE })).toContain('Site/index.html')
  expect(await call($, { tool: 'Write', file_path: `${AI}/docs/../site/x.html`, content: PAGE })).toContain('site/x.html')
  expect(await call($, { tool: 'Write', file_path: 'site/rel.html', content: PAGE })).toContain('site/rel.html')
  expect(await call($, { tool: 'Write', file_path: '~/ai-digest/site/home.html', content: PAGE })).toContain('site/home.html')
  expect(world.allowed).toBe(0)
})

test('a link outside site/ that leads into it is refused', async ($, on) => {
  const world = disk(on)

  const refused = await call($, { tool: 'Write', file_path: `${AI}/docs/link.html`, content: PAGE })

  expect(refused).toContain('site/index.html')
  expect(world.allowed).toBe(0)
})

test('a git that breaks fails closed, but only where the guard has something to refuse', async ($, on) => {
  const world = disk(on, { gitError: 'fatal: detected dubious ownership in repository' })

  const refused = await call($, { tool: 'Write', file_path: `${AI}/site/a.html`, content: PAGE })
  expect(refused).toContain('the site/ guard failed')
  expect(refused).toContain('dubious ownership')
  expect(refused).not.toContain('jane')

  expect(await call($, { tool: 'Write', file_path: `${AI}/site/a.html`, content: 'clean' })).toBeUndefined()
  expect(await call($, { tool: 'Write', file_path: `${AI}/docs/a.md`, content: PAGE })).toBeUndefined()
  expect(world.allowed).toBe(2)
})

// ---------------------------------------------------------------------------
// 2. Gmail writes
// ---------------------------------------------------------------------------

const SERVERS = ['74ffd4a8-ffa4-4112-b84a-7123ff1ec349', 'claude_ai_Gmail']

test('every Gmail write is refused while the session is in ai-digest', async ($, on) => {
  const world = disk(on)

  for (const server of SERVERS) {
    for (const action of GMAIL_WRITE_ACTIONS) {
      const refused = await call($, { tool: `mcp__${server}__${action}`, threadId: 't1' })
      expect(refused).toContain(`Gmail tool ${action} was refused`)
      expect(refused).toContain('search_threads')
    }
  }

  expect(world.allowed).toBe(0)
  expect(world.toasts).toHaveLength(SERVERS.length * GMAIL_WRITE_ACTIONS.size)
  expect(world.toasts[0]).toContain('ai-digest never writes to Gmail')
})

test('the Gmail read actions pass', async ($, on) => {
  const world = disk(on)

  for (const server of SERVERS) {
    for (const action of GMAIL_READ_ACTIONS) {
      expect(await call($, { tool: `mcp__${server}__${action}`, query: 'x' })).toBeUndefined()
    }
  }

  expect(world.allowed).toBe(SERVERS.length * GMAIL_READ_ACTIONS.length)
  expect(world.gitCalls).toBe(0)
})

test('a Gmail write is judged by the session folder', async ($, on) => {
  const world = disk(on)
  const tool = `mcp__${SERVERS[0]}__send_message`

  world.cwd = `${AI}/site/topics`
  expect(await call($, { tool })).toContain('refused')
  world.cwd = WORKTREE
  expect(await call($, { tool })).toContain('refused')

  world.cwd = OTHER
  expect(await call($, { tool })).toBeUndefined()
  world.cwd = SCRATCH
  expect(await call($, { tool })).toBeUndefined()
  world.cwd = '/Users/me'
  expect(await call($, { tool })).toBeUndefined()
  expect(world.allowed).toBe(3)
})

test('other MCP tools and other tool names pass untouched', async ($, on) => {
  const world = disk(on)

  expect(await call($, { tool: 'mcp__linear__save_issue' })).toBeUndefined()
  expect(await call($, { tool: 'mcp__x__slack_send_message' })).toBeUndefined()
  expect(await call($, { tool: 'Read', file_path: `${AI}/README.md` })).toBeUndefined()

  expect(world.allowed).toBe(3)
  expect(world.gitCalls).toBe(0)
})

test('a git that breaks fails closed for a Gmail write, not for a read', async ($, on) => {
  const world = disk(on, { gitError: 'fatal: detected dubious ownership in repository' })

  const refused = await call($, { tool: `mcp__${SERVERS[0]}__trash_thread` })
  expect(refused).toContain('the Gmail guard failed')
  expect(await call($, { tool: `mcp__${SERVERS[0]}__get_thread` })).toBeUndefined()
  expect(world.allowed).toBe(1)
})

// ---------------------------------------------------------------------------
// 3. git push
// ---------------------------------------------------------------------------

test('a failing gate stops the push and shows its output', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING } })

  const refused = await call($, { tool: 'Bash', command: 'git push origin main' })

  expect(world.allowed).toBe(0)
  expect(world.gateRuns).toEqual([{ cwd: AI }])
  expect(refused).toContain('git push was stopped')
  expect(refused).toContain('the gate exited with code 1')
  expect(refused).toContain('check_no_mailbox_links             FAIL (1)')
  expect(refused).toContain('site/daily/2026-05-28.html:47 mailbox identifier in published page')
  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]).toContain('structural gate did not pass in ai-digest')
})

test('a passing gate lets the push through', async ($, on) => {
  const world = disk(on)

  expect(await call($, { tool: 'Bash', command: 'git add -A && git commit -m x && git push' })).toBeUndefined()

  expect(world.allowed).toBe(1)
  expect(world.gateRuns).toEqual([{ cwd: AI }])
  expect(world.toasts).toEqual([])
})

test('the gate runs again on every push: no result is reused', async ($, on) => {
  const world = disk(on)

  await call($, { tool: 'Bash', command: 'git push' })
  world.gate = { exitCode: 1, stdout: FAILING }
  const refused = await call($, { tool: 'Bash', command: 'git push' })

  expect(world.gateRuns).toHaveLength(2)
  expect(refused).toContain('FAIL (1)')
})

test('commands that are not pushes, and dry runs, pass without the gate', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING } })

  for (const command of ['git status', 'git commit -m "x"', 'ls -la', 'git log --grep push', 'git push --dry-run', 'git push -n origin main']) {
    expect(await call($, { tool: 'Bash', command })).toBeUndefined()
  }

  expect(world.gateRuns).toEqual([])
  expect(world.gitCalls).toBe(0)
  expect(world.allowed).toBe(6)
})

test('a push in another repo, or outside any repo, is not gated', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING } })

  world.cwd = OTHER
  expect(await call($, { tool: 'Bash', command: 'git push' })).toBeUndefined()
  world.cwd = SCRATCH
  expect(await call($, { tool: 'Bash', command: 'git push' })).toBeUndefined()
  world.cwd = AI
  expect(await call($, { tool: 'Bash', command: `cd ${OTHER} && git push` })).toBeUndefined()
  expect(await call($, { tool: 'Bash', command: `git -C ${OTHER} push` })).toBeUndefined()

  expect(world.gateRuns).toEqual([])
  expect(world.allowed).toBe(4)
})

test('a push that names ai-digest by -C or cd is gated from anywhere', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING } })

  world.cwd = SCRATCH
  expect(await call($, { tool: 'Bash', command: `git -C ${AI} push` })).toContain('git push was stopped')
  expect(await call($, { tool: 'Bash', command: `cd ${AI} && git push` })).toContain('git push was stopped')
  expect(await call($, { tool: 'Bash', command: `git -C ${AI}/site/topics push` })).toContain('git push was stopped')
  world.cwd = '/Users/me'
  expect(await call($, { tool: 'Bash', command: 'cd ai-digest && git push' })).toContain('git push was stopped')
  expect(await call($, { tool: 'Bash', command: 'git -C ~/ai-digest push' })).toContain('git push was stopped')
  expect(await call($, { tool: 'Bash', command: 'cd $HOME/ai-digest && git push' })).toContain('git push was stopped')

  expect(world.gateRuns.every(run => run.cwd === AI)).toBe(true)
  expect(world.gateRuns).toHaveLength(6)
  expect(world.allowed).toBe(0)
})

test('a folder named through an unknown variable falls back to the session folder', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING } })

  expect(await call($, { tool: 'Bash', command: 'cd $PROJECT && git push' })).toContain('git push was stopped')

  world.cwd = OTHER
  expect(await call($, { tool: 'Bash', command: 'cd $PROJECT && git push' })).toBeUndefined()
})

test('a worktree is gated by its gate script', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING }, cwd: WORKTREE })

  expect(await call($, { tool: 'Bash', command: 'git push' })).toContain('git push was stopped')
  expect(world.gateRuns).toEqual([{ cwd: WORKTREE }])
})

test('two pushes to one repo in one command run the gate once', async ($, on) => {
  const world = disk(on)

  expect(await call($, { tool: 'Bash', command: 'git push origin main && git push origin --tags' })).toBeUndefined()

  expect(world.gateRuns).toHaveLength(1)
  expect(world.allowed).toBe(1)
})

test('a command that pushes ai-digest and another repo is stopped by the failing one', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING }, cwd: OTHER })

  const refused = await call($, { tool: 'Bash', command: `git push && git -C ${AI} push` })

  expect(refused).toContain('git push was stopped')
  expect(world.gateRuns).toEqual([{ cwd: AI }])
})

test('a shell without python3 is retried as the user\'s own shell', async ($, on) => {
  const world = disk(on, { isPythonMissing: true })

  expect(await call($, { tool: 'Bash', command: 'git push' })).toBeUndefined()

  expect(world.gateRuns).toHaveLength(1)
  expect(world.shellRuns).toBe(1)
  expect(world.allowed).toBe(1)
})

test('no python3 anywhere stops the push', async ($, on) => {
  const world = disk(on, { isPythonMissing: 'everywhere' })

  const refused = await call($, { tool: 'Bash', command: 'git push' })

  expect(refused).toContain('code 127')
  expect(refused).toContain('command not found: python3')
  expect(world.allowed).toBe(0)
})

test('a missing gate script stops the push', async ($, on) => {
  const world = disk(on, { cwd: FORK })

  const refused = await call($, { tool: 'Bash', command: 'git push' })

  expect(refused).toContain(`${SCRIPT} is missing`)
  expect(world.gateRuns).toEqual([])
  expect(world.allowed).toBe(0)
})

test('a gate that cannot start stops the push', async ($, on) => {
  const world = disk(on, { gate: 'cannot start' })

  const refused = await call($, { tool: 'Bash', command: 'git push' })

  expect(refused).toContain('the gate could not run')
  expect(refused).toContain('ENOENT')
  expect(world.allowed).toBe(0)
})

test('an exit 0 without the gate\'s summary is not a pass', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 0, stdout: '' } })

  const refused = await call($, { tool: 'Bash', command: 'git push' })

  expect(refused).toContain('did not print its "0 failure(s)" summary')
  expect(world.allowed).toBe(0)
})

test('a git that breaks fails closed for a push, not for other commands', async ($, on) => {
  const world = disk(on, { gitError: 'fatal: detected dubious ownership in repository' })

  const refused = await call($, { tool: 'Bash', command: 'git push' })
  expect(refused).toContain('the push guard failed')
  expect(await call($, { tool: 'Bash', command: 'git status' })).toBeUndefined()
  expect(world.allowed).toBe(1)
})

test('a push to a folder that does not exist is left to git to fail', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING } })

  expect(await call($, { tool: 'Bash', command: 'cd /nowhere && git push' })).toBeUndefined()
  expect(world.gateRuns).toEqual([])
  expect(world.gitCalls).toBe(0)
})

test('each refusal raises one toast, and nothing else on screen', async ($, on) => {
  const world = disk(on, { gate: { exitCode: 1, stdout: FAILING } })

  await call($, { tool: 'Bash', command: 'git push' })
  await call($, { tool: 'Write', file_path: `${AI}/site/a.html`, content: PAGE })
  await call($, { tool: `mcp__${SERVERS[0]}__reply` })

  expect(world.toasts).toHaveLength(3)
})
