import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

const HOME = '/Users/me'
const PROJECTS = `${HOME}/projects`
const REPO = `${PROJECTS}/boe-agent`
// A checkout under another name: found by the file only boe-agent has.
const COPY = `${PROJECTS}/boe-agent-copy`
// A repo that has a PROGRESS.md and plans of its own, and is not boe-agent.
const OTHER = `${PROJECTS}/other`

const PLAN = 'docs/superpowers/plans/2026-10-03-demo-web.md'
const U = 'uv run python -m boe_agent.comandos'

const ok = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type World = {
  cwd: string
  roots: string[]
  // Roots that hold the file only boe-agent has.
  marked: string[]
  // Paths that are links, and where they lead.
  links: Map<string, string>
  plans: string[]
  isGitBroken: boolean
  engine: 'allow' | 'deny'
  // How the person answers the permission dialog; absent, nobody is there.
  person?: 'allow' | 'deny'
  gitCalls: number
  statCalls: number
  ran: string[]
  toasts: string[]
}

function rootOf(world: World, dir: string): string | undefined {
  return world.roots.filter(r => dir === r || dir.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
}

// Stands for the engine, git, the file system and the person, beneath the plugin.
function setup(on: On, overrides: Partial<World> = {}): World {
  const world: World = {
    cwd: REPO,
    roots: [REPO, COPY, OTHER],
    marked: [COPY],
    links: new Map(),
    plans: ['2026-10-03-demo-web.md', '2026-10-28-trazas-phoenix.md'],
    isGitBroken: false,
    engine: 'allow',
    gitCalls: 0,
    statCalls: 0,
    ran: [],
    toasts: [],
    ...overrides,
  }
  mock.env(on, { HOME })
  on('session.cwd', () => ({ value: world.cwd }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', (_, e) => {
    const p = e.path
    const isRepoFile = world.roots.some(r => p === r || p.startsWith(`${r}/`))
    const isAncestor = world.roots.some(r => r.startsWith(`${p}/`)) || p === '/tmp/loose'
    const isMarker = world.marked.some(r => p === `${r}/src/boe_agent/comandos/barrido_boe.py`)
    const isUnmarkedMarker = p.endsWith('/src/boe_agent/comandos/barrido_boe.py') && !isMarker
    return { value: !isUnmarkedMarker && (isRepoFile || isAncestor || p === '/tmp/loose' || p.startsWith('/tmp/loose/')) }
  })
  on('fs.stat', (_, e) => {
    world.statCalls += 1
    const real = world.links.get(e.path)
    if (real === undefined && !e.path.startsWith('/tmp/') && !rootOf(world, e.path)) return { deny: 'ENOENT' }
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: real !== undefined, realPath: real ?? e.path } }
  })
  on('fs.list', (_, e) => {
    if (e.path.endsWith('/docs/superpowers/plans')) {
      return { value: world.plans.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
    }
    return { deny: 'ENOENT' }
  })
  on('process.run', (_, e) => {
    if (e.argv.join(' ') !== 'git rev-parse --show-toplevel --show-prefix') throw new Error(`unexpected command: ${e.argv.join(' ')}`)
    world.gitCalls += 1
    if (world.isGitBroken) return { deny: 'git is gone' }
    const dir = e.init?.cwd ?? world.cwd
    const root = rootOf(world, dir)
    if (root === undefined) return ok('', 128)
    const prefix = dir === root ? '' : `${dir.slice(root.length + 1)}/`
    return ok(`${root}\n${prefix}\n`)
  })
  on('tool.call', (_, e) => {
    const input = e as { tool: string; command?: string; file_path?: string }
    world.ran.push(`${input.tool}:${input.command ?? input.file_path ?? ''}`)
    return { result: {} }
  })
  on('tool.check', () => ({ decision: world.engine, reason: world.engine === 'deny' ? 'a settings rule denies it' : undefined }))
  if (world.person !== undefined) {
    const behavior = world.person
    on('classic.PermissionRequest', () => ({ decision: { behavior } }))
  }
  on('classic.CwdChanged', () => ({}))
  return world
}

type Called = { deny?: string; isError?: boolean; text?: string }
type Caller = { tool: { call: (input: never) => Promise<unknown> } }

// What the model reads when a call was refused, else undefined.
async function refusal($: Caller, input: Record<string, unknown>): Promise<string | undefined> {
  const done = (await $.tool.call(input as never)) as Called
  return done.deny ?? (done.isError ? done.text : undefined)
}

const read = ($: Caller, file_path: string, extra: Record<string, unknown> = {}) =>
  refusal($, { tool: 'Read', file_path, ...extra })
const bash = ($: Caller, command: string) => refusal($, { tool: 'Bash', command })

// ------------------------------------------------------------ read guard

test('a whole read of PROGRESS.md is refused, with how to read a section', async ($, on) => {
  const world = setup(on)

  const refused = await read($, `${REPO}/PROGRESS.md`)

  expect(refused).toContain('boe-guard refused the read of PROGRESS.md')
  expect(refused).toContain('no `limit`')
  expect(refused).toContain("grep -n '^## ' PROGRESS.md")
  expect(refused).toContain('`offset`')
  expect(refused).toContain('`limit`')
  expect(world.ran).toEqual([])
  expect(world.toasts).toEqual(['boe-guard: Claude tried to read all of PROGRESS.md; it was told to read one section instead.'])
})

test('a read of PROGRESS.md with a limit goes through', async ($, on) => {
  const world = setup(on)

  expect(await read($, `${REPO}/PROGRESS.md`, { offset: 400, limit: 120 })).toBeUndefined()
  expect(await read($, `${REPO}/PROGRESS.md`, { limit: 1000 })).toBeUndefined()

  expect(world.ran).toHaveLength(2)
  expect(world.toasts).toEqual([])
})

test('a limit that is no section is refused too', async ($, on) => {
  const world = setup(on)

  const refused = await read($, `${REPO}/PROGRESS.md`, { limit: 100000 })

  expect(refused).toContain('over 1000 lines')
  expect(world.ran).toEqual([])
})

test('the plans folder is guarded the same way', async ($, on) => {
  const world = setup(on)

  const refused = await read($, `${REPO}/${PLAN}`)
  expect(refused).toContain(`boe-guard refused the read of ${PLAN}`)
  expect(refused).toContain("grep -n '^#'")
  expect(await read($, `${REPO}/${PLAN}`, { offset: 1, limit: 80 })).toBeUndefined()
  expect(await read($, `${REPO}/docs/superpowers/plans/2026-10-28-trazas-phoenix.md`)).toContain('refused')

  expect(world.ran).toEqual([`Read:${REPO}/${PLAN}`])
})

test('spellings of the same file: lower case, dots, a relative path, a link, a subagent', async ($, on) => {
  const world = setup(on, { links: new Map([['/tmp/loose/p.md', `${REPO}/PROGRESS.md`]]) })

  expect(await read($, `${REPO}/progress.md`)).toContain('refused')
  expect(await read($, `${REPO}/docs/../PROGRESS.md`)).toContain('refused')
  expect(await read($, 'PROGRESS.md')).toContain('refused')
  expect(await read($, `${REPO}/docs/superpowers/plans/../plans/${PLAN.split('/').pop()}`)).toContain('refused')
  expect(await read($, '/tmp/loose/p.md')).toContain('refused')
  expect(await refusal($, { tool: 'Read', file_path: `${REPO}/PROGRESS.md`, agentId: 'a1' })).toContain('refused')
  expect(world.ran).toEqual([])
})

test('a checkout under another name is the repo too', async ($, on) => {
  const world = setup(on)

  expect(await read($, `${COPY}/PROGRESS.md`)).toContain('refused')
  expect(await read($, `${COPY}/PROGRESS.md`, { limit: 50 })).toBeUndefined()
  expect(world.ran).toHaveLength(1)
})

test('every other file reads freely, and costs no process', async ($, on) => {
  const world = setup(on)

  for (const file of [
    `${REPO}/AGENTS.md`,
    `${REPO}/README.md`,
    `${REPO}/docs/superpowers/specs/estado-actual.md`,
    `${REPO}/docs/superpowers/specs/carga-de-meses.md`,
    `${REPO}/docs/superpowers/plans-notes/x.md`,
    `${REPO}/src/boe_agent/comandos/barrido.py`,
    `${REPO}/tests/PROGRESS.md.bak`,
  ]) {
    expect(await read($, file)).toBeUndefined()
  }
  expect(world.ran).toHaveLength(7)
  expect(world.gitCalls).toBe(0)
  expect(world.toasts).toEqual([])
})

test('a read with a limit costs no process either', async ($, on) => {
  const world = setup(on)

  await read($, `${REPO}/PROGRESS.md`, { limit: 100 })

  expect(world.gitCalls).toBe(0)
  expect(world.statCalls).toBe(0)
})

test('the same file names outside boe-agent are left alone', async ($, on) => {
  const world = setup(on)

  expect(await read($, `${OTHER}/PROGRESS.md`)).toBeUndefined()
  expect(await read($, `${OTHER}/${PLAN}`)).toBeUndefined()
  expect(await read($, '/tmp/loose/PROGRESS.md')).toBeUndefined()
  expect(await read($, '/tmp/loose/docs/superpowers/plans/x.md')).toBeUndefined()

  expect(world.ran).toHaveLength(4)
  expect(world.toasts).toEqual([])
})

test('a read guard that breaks fails closed', async ($, on) => {
  const world = setup(on, { isGitBroken: true })

  const refused = await read($, `${REPO}/PROGRESS.md`)

  expect(refused).toContain('the read guard failed')
  expect(refused).toContain('git is gone')
  expect(world.ran).toEqual([])
  // Files it never needs git for are not held up.
  expect(await read($, `${REPO}/AGENTS.md`)).toBeUndefined()
})

// ----------------------------------------------------------- dump guard

test('cat of PROGRESS.md is refused, with how to print a section', async ($, on) => {
  const world = setup(on)

  const refused = await bash($, 'cat PROGRESS.md')

  expect(refused).toContain('boe-guard refused this command')
  expect(refused).toContain('all of PROGRESS.md')
  expect(refused).toContain("sed -n 'START,ENDp' PROGRESS.md")
  expect(world.ran).toEqual([])
  expect(world.toasts).toHaveLength(1)
})

test('less, more and a plan are refused; a pipe into head, sed or grep passes', async ($, on) => {
  const world = setup(on)

  expect(await bash($, 'less PROGRESS.md')).toContain('refused')
  expect(await bash($, 'more PROGRESS.md')).toContain('refused')
  expect(await bash($, `cat ${PLAN}`)).toContain('refused')
  expect(await bash($, 'cat docs/superpowers/plans/*.md')).toContain('refused')
  expect(await bash($, 'cat docs/superpowers/plans/2026-10-0*')).toContain('refused')
  expect(world.ran).toEqual([])

  expect(await bash($, 'cat PROGRESS.md | head -50')).toBeUndefined()
  expect(await bash($, "cat PROGRESS.md | sed -n '100,200p'")).toBeUndefined()
  expect(await bash($, "cat PROGRESS.md | grep -n '^## '")).toBeUndefined()
  expect(world.ran).toHaveLength(3)
})

test('cd boe-agent && cat, from the folder above', async ($, on) => {
  const world = setup(on, { cwd: PROJECTS })

  expect(await bash($, 'cd boe-agent && cat PROGRESS.md')).toContain('refused')
  expect(await bash($, 'cat boe-agent/PROGRESS.md')).toContain('refused')
  expect(await bash($, `bash -c 'cd ${REPO} && less PROGRESS.md'`)).toContain('refused')
  // The folder above is no repo: a PROGRESS.md there is not guarded.
  expect(await bash($, 'cat PROGRESS.md')).toBeUndefined()
  expect(world.ran).toEqual(['Bash:cat PROGRESS.md'])
})

test('other files and other repos pass, and cost no process when the name is not a protected one', async ($, on) => {
  const world = setup(on)

  expect(await bash($, 'cat AGENTS.md')).toBeUndefined()
  expect(await bash($, 'cat docs/superpowers/specs/estado-actual.md')).toBeUndefined()
  expect(await bash($, "grep -n '^## ' PROGRESS.md")).toBeUndefined()
  expect(await bash($, "echo 'cat PROGRESS.md'")).toBeUndefined()
  expect(await bash($, 'git log --oneline')).toBeUndefined()
  expect(world.gitCalls).toBe(0)

  expect(await bash($, `cd ${OTHER} && cat PROGRESS.md`)).toBeUndefined()
  expect(await bash($, 'cat /tmp/loose/PROGRESS.md')).toBeUndefined()
  expect(world.ran).toHaveLength(7)
})

test('a dump guard that breaks fails closed, and only for commands that name a protected file', async ($, on) => {
  const world = setup(on, { isGitBroken: true })

  const refused = await bash($, 'cat PROGRESS.md')

  expect(refused).toContain('the dump guard failed')
  expect(world.ran).toEqual([])
  expect(await bash($, 'ls -la')).toBeUndefined()
  expect(await bash($, 'cat AGENTS.md')).toBeUndefined()
})

test('a folder the shell moved to is used for a relative path', async ($, on) => {
  const world = setup(on, { cwd: PROJECTS })

  await $.classic.CwdChanged({ old_cwd: PROJECTS, new_cwd: REPO })
  expect(await bash($, 'cat PROGRESS.md')).toContain('refused')
  await $.classic.CwdChanged({ old_cwd: REPO, new_cwd: PROJECTS })
  expect(await bash($, 'cat PROGRESS.md')).toBeUndefined()
  expect(world.ran).toHaveLength(1)
})

// --------------------------------------------------------- load question

const check = ($: { tool: { check: (input: never) => Promise<{ decision: string; reason?: string }> } }, command: string) =>
  $.tool.check({ tool: 'Bash', input: { command } } as never)

test('a BDNS load asks the person, naming the source and the month', async ($, on) => {
  setup(on)

  const verdict = await check($, `${U}.barrido 2026-09-01 2026-09-12`)

  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('BDNS (infosubvenciones.es)')
  expect(verdict.reason).toContain('month 2026-09')
  expect(verdict.reason).toContain('days 2026-09-01 to 2026-09-12')
  expect(verdict.reason).toContain('ask the user in chat')
})

test('a BOE load asks too, and a range names every month', async ($, on) => {
  setup(on)

  const one = await check($, `${U}.recogida_boe 2025-03-12`)
  expect(one.decision).toBe('ask')
  expect(one.reason).toContain('BOE section 5A (boe.es)')
  expect(one.reason).toContain('month 2025-03')

  const many = await check($, `BOE_AGENT_DSN=postgresql://boe:boe@localhost:5433/boe ${U}.barrido_boe 2025-07-01 2025-12-31`)
  expect(many.decision).toBe('ask')
  expect(many.reason).toContain('months 2025-07 to 2025-12 (6 months)')
})

test('cd boe-agent && uv run ..., from the folder above, asks', async ($, on) => {
  setup(on, { cwd: PROJECTS })

  const verdict = await check($, `cd boe-agent && ${U}.barrido 2025-03-01 2025-03-31`)

  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('month 2025-03')
  expect((await check($, `uv run --directory boe-agent python -m boe_agent.comandos.barrido 2025-03-01 2025-03-31`)).decision).toBe('ask')
})

test('the queue says it names no month', async ($, on) => {
  setup(on)

  const verdict = await check($, `${U}.cola procesar boe --maximo 31 2> "$TMPDIR/cola-boe.jsonl"`)

  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('BOE section 5A (boe.es)')
  expect(verdict.reason).toContain('names no month')
})

test('a checkout under another name asks too', async ($, on) => {
  setup(on, { cwd: COPY })

  expect((await check($, `${U}.barrido 2026-09-01 2026-09-12`)).decision).toBe('ask')
})

test('what is not a load is not asked about', async ($, on) => {
  const world = setup(on)

  for (const command of [
    `${U}.barrido --completitud 2025-01-01 2025-12-31`,
    `${U}.barrido_boe --completitud 2025-01-01 2025-01-31`,
    `${U}.cola estado bdns 2025-01-01 2025-01-31`,
    `${U}.cola encolar bdns 2025-01-01 2025-01-31`,
    `${U}.proyeccion 2026-09-01 2026-09-12`,
    `${U}.proyeccion_boe 2025-03-12`,
    `${U}.cobertura 2025-01`,
    `${U}.metricas`,
    'uv run pytest -m red',
    "grep -rn 'boe_agent.comandos.barrido' src/",
    `git commit -m "docs: run ${U}.barrido 2025-01-01 2025-01-31"`,
    'ls',
  ]) {
    expect((await check($, command)).decision).toBe('allow')
  }
  // Only commands that run a load module look at the repo at all.
  expect(world.gitCalls).toBe(0)
})

test('outside boe-agent the same command is not asked about', async ($, on) => {
  setup(on, { cwd: OTHER })
  expect((await check($, `${U}.barrido 2026-09-01 2026-09-12`)).decision).toBe('allow')
  expect((await check($, `${U}.cola procesar bdns --maximo 31`)).decision).toBe('allow')
})

test('in a folder that is no repo it is not asked about either', async ($, on) => {
  setup(on, { cwd: '/tmp/loose' })

  expect((await check($, `${U}.barrido 2026-09-01 2026-09-12`)).decision).toBe('allow')
  expect((await check($, `cd ${OTHER} && ${U}.barrido 2026-09-01 2026-09-12`)).decision).toBe('allow')
  // Moving into boe-agent with cd brings it back.
  expect((await check($, `cd ${REPO} && ${U}.barrido 2026-09-01 2026-09-12`)).decision).toBe('ask')
})

test('a refusal from the engine stands: the question does not turn a deny into an ask', async ($, on) => {
  setup(on, { engine: 'deny' })

  const verdict = await check($, `${U}.barrido 2026-09-01 2026-09-12`)

  expect(verdict.decision).toBe('deny')
  expect(verdict.reason).toBe('a settings rule denies it')
})

test('the tool.call guards leave a load to the question: approved, it runs', async ($, on) => {
  const world = setup(on, { person: 'allow' })

  expect(await bash($, `${U}.barrido 2026-09-01 2026-09-12`)).toBeUndefined()

  expect(world.ran).toHaveLength(1)
  expect(world.toasts).toEqual([])
})

test('a load the person refuses does not run', async ($, on) => {
  const world = setup(on, { person: 'deny' })

  expect(await bash($, `${U}.barrido 2026-09-01 2026-09-12`)).toBeDefined()

  expect(world.ran).toHaveLength(0)
})

test('a load with nobody there to answer does not run', async ($, on) => {
  const world = setup(on)

  expect(await bash($, `${U}.barrido 2026-09-01 2026-09-12`)).toBeDefined()

  expect(world.ran).toHaveLength(0)
})

test('a load check that breaks fails closed, and only for commands that run a load module', async ($, on) => {
  setup(on, { isGitBroken: true })

  const verdict = await check($, `${U}.barrido 2026-09-01 2026-09-12`)

  expect(verdict.decision).toBe('deny')
  expect(verdict.reason).toContain('its load check failed')
  expect(verdict.reason).toContain('ask the user in chat')
  expect((await check($, 'ls -la')).decision).toBe('allow')
  expect((await check($, `${U}.cobertura`)).decision).toBe('allow')
})

test('a call that carries no command or path is left to the tool', async ($, on) => {
  const world = setup(on)

  expect(await refusal($, { tool: 'Read' })).toBeUndefined()
  expect(await refusal($, { tool: 'Bash' })).toBeUndefined()
  expect(world.ran).toHaveLength(2)
})
