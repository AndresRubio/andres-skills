import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { applyEdit } from '../hooks/logic'

const EMPIRE = '/w/warhammer/src/data/armies/empire.ts'
const ITEMS = '/w/warhammer/src/data/magicItems.ts'
const CITATIONS = '/w/warhammer/CITATIONS.md'

const EMPIRE_TEXT = `const units: UnitProfile[] = [
  {
    id: 'emp-general',
    name: 'General of the Empire',
    role: 'character',
    pointsPerModel: 100,
    statLine: human({ WS: 6, BS: 6, S: 4, T: 4, W: 3, I: 6, A: 4, Ld: 9 }),
    specialRules: [
      'Commander (up to 3 magic items)',
      'May ride a Warhorse (+3 pts) or a Monster',
    ],
  },
]
`

const ITEMS_TEXT = `export const COMMON_MAGIC_ITEMS: MagicItem[] = [
  {"id": "mi-sword-of-death", "name": "Sword of Death", "category": "weapon", "points": 100, "description": "The wielder has Strength 10."},
]
`

const ok = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type World = {
  files: Map<string, string>
  // Repos by root: whether each holds CITATIONS.md and package.json is read from `files`.
  roots: string[]
  // Edits that fail, and files that cannot be read.
  failing: Set<string>
  unreadable: Set<string>
  isExistsBroken: boolean
  cwd: string
  allowed: string[]
  reads: string[]
  gits: string[]
  toasts: string[]
  registered: string[]
}

// Stands for the engine, the disk and git: /w/warhammer holds CITATIONS.md and
// package.json, /w/other has the same folders but no CITATIONS.md.
function repo(on: On, overrides: Partial<World> = {}): World {
  const world: World = {
    files: new Map([
      [EMPIRE, EMPIRE_TEXT],
      [ITEMS, ITEMS_TEXT],
      [CITATIONS, '# Citations\n'],
      ['/w/warhammer/package.json', '{}'],
      ['/w/warhammer/src/App.tsx', 'export {}'],
      ['/w/warhammer/src/data/armies/armies.test.ts', 'const x = { points: 1 }'],
      ['/w/other/src/data/armies/empire.ts', EMPIRE_TEXT],
      ['/w/other/package.json', '{}'],
    ]),
    roots: ['/w/warhammer', '/w/other'],
    failing: new Set(),
    unreadable: new Set(),
    isExistsBroken: false,
    cwd: '/w/warhammer',
    allowed: [],
    reads: [],
    gits: [],
    toasts: [],
    registered: [],
    ...overrides,
  }
  const folders = () => {
    const out = new Set<string>(world.roots)
    for (const path of world.files.keys()) {
      for (let dir = path.slice(0, path.lastIndexOf('/')); dir.length > 1; dir = dir.slice(0, dir.lastIndexOf('/'))) {
        out.add(dir)
      }
    }
    return out
  }

  on('session.cwd', () => ({ value: world.cwd }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', (_, e) => {
    world.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => {
    if (world.isExistsBroken) return { deny: 'disk gone' }
    return { value: world.files.has(e.path) || folders().has(e.path) }
  })
  on('fs.read', (_, e) => {
    world.reads.push(e.path)
    const text = world.files.get(e.path)
    if (text === undefined || world.unreadable.has(e.path)) return { deny: `ENOENT: ${e.path}` }
    return { value: text }
  })
  on('process.run', (_, e) => {
    const cwd = e.init?.cwd ?? '/'
    if (e.argv.join(' ') !== 'git rev-parse --show-toplevel --show-prefix') throw new Error(`unexpected command: ${e.argv.join(' ')}`)
    world.gits.push(cwd)
    const root = world.roots.find(r => cwd === r || cwd.startsWith(`${r}/`))
    if (root === undefined) return ok('', 128)
    const prefix = cwd === root ? '' : `${cwd.slice(root.length + 1)}/`
    return ok(`${root}\n${prefix}\n`)
  })
  // The tool beneath the plugin: applies the edit to the disk.
  on('tool.call', (_, e) => {
    const input = e as { tool: string; file_path: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean }
    const path = input.file_path.startsWith('/') ? input.file_path : `${world.cwd}/${input.file_path}`
    if (world.failing.has(path)) return { isError: true as const, result: 'Error: no match', text: 'Error: no match' }
    world.allowed.push(path)
    if (input.tool === 'Write') world.files.set(path, input.content ?? '')
    if (input.tool === 'Edit') {
      const next = applyEdit(world.files.get(path) ?? '', input.old_string ?? '', input.new_string ?? '', input.replace_all === true)
      if (next !== undefined) world.files.set(path, next)
    }
    return { result: {} }
  })
  return world
}

const edit = ($: Engine, file_path: string, old_string: string, new_string: string) =>
  $.tool.call({ tool: 'Edit', file_path, old_string, new_string })

const write = ($: Engine, file_path: string, content: string) =>
  $.tool.call({ tool: 'Write', file_path, content })

const endTurn = ($: Engine, agentId?: string) =>
  $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })

const list = async ($: Engine) =>
  (
    await $.command.run({
      command: 'citation-guard',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text

test('a points edit runs, and the model is told which value changed and that CITATIONS.md needs the page', async ($, on) => {
  const world = repo(on)

  const ran = await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')

  expect(world.allowed).toEqual([EMPIRE])
  expect(world.files.get(EMPIRE)).toContain('pointsPerModel: 110,')
  const note = ran.context?.join('\n') ?? ''
  expect(note).toContain('src/data/armies/empire.ts')
  expect(note).toContain('emp-general pointsPerModel: 100 -> 110')
  expect(note).toContain('CITATIONS.md')
  expect(note).toContain('book page')
  expect(note).toContain('same turn')
})

test('a stat edit names the stat', async ($, on) => {
  repo(on)

  const ran = await edit($, EMPIRE, 'human({ WS: 6, BS: 6,', 'human({ WS: 5, BS: 6,')

  expect(ran.context?.join('\n')).toContain('emp-general statLine.WS: 6 -> 5')
})

test('a magic item cost edit is noted in the catalogue file', async ($, on) => {
  repo(on)

  const ran = await edit($, ITEMS, '"points": 100', '"points": 90')

  expect(ran.context?.join('\n')).toContain('mi-sword-of-death points: 100 -> 90')
})

test('an edit that only touches text gets no note and no toast', async ($, on) => {
  const world = repo(on)

  const ran = await edit($, EMPIRE, "name: 'General of the Empire',", "name: 'Imperial General (0-1)',")
  const ran2 = await edit($, EMPIRE, "'May ride a Warhorse (+3 pts) or a Monster'", "'May ride a Warhorse (+4 pts)'")
  await endTurn($)

  expect(world.allowed).toHaveLength(2)
  expect(ran.context).toBeUndefined()
  expect(ran2.context).toBeUndefined()
  expect(world.toasts).toEqual([])
  expect(await list($)).toBe('Citation guard: no uncited value changes this session.')
})

test('a Write is compared with the file it replaces', async ($, on) => {
  const world = repo(on)

  const reflowed = EMPIRE_TEXT.replace('pointsPerModel: 100,', 'pointsPerModel:   100.0 ,')
  expect((await write($, EMPIRE, reflowed)).context).toBeUndefined()

  const changed = reflowed.replace('Ld: 9', 'Ld: 10')
  const ran = await write($, EMPIRE, changed)
  expect(ran.context?.join('\n')).toContain('emp-general statLine.Ld: 9 -> 10')
  expect(world.files.get(EMPIRE)).toBe(changed)
})

test('a Write that creates an army file notes its numbers as new', async ($, on) => {
  const world = repo(on)
  const path = '/w/warhammer/src/data/armies/ogres.ts'
  expect(world.files.has(path)).toBe(false)

  const ran = await write($, path, "const units = [{ id: 'og-bull', pointsPerModel: 30 }]\n")

  expect(ran.context?.join('\n')).toContain('og-bull pointsPerModel: (new) -> 30')
})

test('at turn end a toast names the files whose values changed, once', async ($, on) => {
  const world = repo(on)

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await edit($, ITEMS, '"points": 100', '"points": 90')
  expect(world.toasts).toEqual([])

  await endTurn($)
  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]).toContain('armies/empire.ts and magicItems.ts')
  expect(world.toasts[0]).toContain('CITATIONS.md was not edited')

  await endTurn($)
  expect(world.toasts).toHaveLength(1)
})

test('no toast when CITATIONS.md was edited in the same turn', async ($, on) => {
  const world = repo(on)

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await edit($, CITATIONS, '# Citations', '# Citations\n- Imperio p.54: General 110 pts')
  await endTurn($)

  expect(world.toasts).toEqual([])
  expect(await list($)).toBe('Citation guard: no uncited value changes this session.')
})

test('citing first counts too, and the note then says it was already edited', async ($, on) => {
  const world = repo(on)

  await edit($, CITATIONS, '# Citations', '# Citations\n- Imperio p.54')
  const ran = await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await endTurn($)

  expect(ran.context?.join('\n')).toContain('already edited this turn')
  expect(world.toasts).toEqual([])
})

test('a CITATIONS.md edit that failed does not count', async ($, on) => {
  const world = repo(on, { failing: new Set([CITATIONS]) })

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  const cited = await edit($, CITATIONS, '# Citations', '# Citations\n- x')
  await endTurn($)

  expect(cited.isError).toBe(true)
  expect(world.toasts).toHaveLength(1)
})

test('a citation in a later turn clears what an earlier turn left open', async ($, on) => {
  const world = repo(on)

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await endTurn($)
  expect(world.toasts).toHaveLength(1)
  expect(await list($)).toContain('emp-general pointsPerModel: 100 -> 110')

  await edit($, CITATIONS, '# Citations', '# Citations\n- Imperio p.54')
  await endTurn($)

  expect(world.toasts).toHaveLength(1)
  expect(await list($)).toBe('Citation guard: no uncited value changes this session.')
})

test('a value put back is not nagged about', async ($, on) => {
  const world = repo(on)

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  const back = await edit($, EMPIRE, 'pointsPerModel: 110,', 'pointsPerModel: 100,')
  await endTurn($)

  expect(back.context).toBeUndefined()
  expect(world.toasts).toEqual([])
})

test('a failed edit records nothing', async ($, on) => {
  const world = repo(on, { failing: new Set([EMPIRE]) })

  const ran = await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await endTurn($)

  expect(ran.isError).toBe(true)
  expect(ran.context).toBeUndefined()
  expect(world.toasts).toEqual([])
})

test("a subagent's turn end shows nothing and keeps the main turn's changes", async ($, on) => {
  const world = repo(on)

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await endTurn($, 'sub-1')
  expect(world.toasts).toEqual([])

  await endTurn($)
  expect(world.toasts).toHaveLength(1)
})

test('/citation-guard lists the uncited changes with file, old and new value', async ($, on) => {
  repo(on)

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await edit($, EMPIRE, 'Ld: 9', 'Ld: 8')
  await edit($, ITEMS, '"points": 100', '"points": 90')

  const text = await list($)
  expect(text).toContain('3 uncited value changes in 2 files')
  expect(text).toContain('src/data/armies/empire.ts\n  emp-general pointsPerModel: 100 -> 110\n  emp-general statLine.Ld: 9 -> 8')
  expect(text).toContain('src/data/magicItems.ts\n  mi-sword-of-death points: 100 -> 90')
})

test('two edits to one value list as one change from the first old value', async ($, on) => {
  repo(on)

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await edit($, EMPIRE, 'pointsPerModel: 110,', 'pointsPerModel: 120,')

  const text = (await list($)) ?? ''
  expect(text).toContain('1 uncited value change in 1 file')
  expect(text).toContain('emp-general pointsPerModel: 100 -> 120')
})

test('another repo is left alone: no CITATIONS.md at its root', async ($, on) => {
  const world = repo(on, { cwd: '/w/other' })
  const path = '/w/other/src/data/armies/empire.ts'

  const ran = await edit($, path, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await endTurn($)

  expect(world.allowed).toEqual([path])
  expect(ran.context).toBeUndefined()
  expect(world.reads).not.toContain(path)
  expect(world.toasts).toEqual([])
  expect(await list($)).toBe('Citation guard: no uncited value changes this session.')
})

test('a CITATIONS.md of another repo does not cite this one', async ($, on) => {
  const world = repo(on)
  world.files.set('/w/other/CITATIONS.md', '# Other\n')

  await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await edit($, '/w/other/CITATIONS.md', '# Other', '# Other\n- x')
  await endTurn($)

  expect(world.toasts).toHaveLength(1)
})

test('files that are not army data never reach git or the disk', async ($, on) => {
  const world = repo(on)

  for (const path of [
    '/w/warhammer/src/App.tsx',
    '/w/warhammer/PROGRESS.md',
    '/w/warhammer/src/data/armies/armies.test.ts',
    '/w/warhammer/docs/CITATIONS.md',
    '/elsewhere/notes.txt',
  ]) {
    world.files.set(path, 'x')
    const ran = await edit($, path, 'x', 'y')
    expect(ran.context).toBeUndefined()
  }
  await endTurn($)

  expect(world.allowed).toHaveLength(5)
  // Only the two files that look like data or citations can cost a git call.
  expect(world.gits.length).toBeLessThanOrEqual(2)
  expect(world.reads).toEqual([])
  expect(world.toasts).toEqual([])
})

test('a path relative to the session folder is found', async ($, on) => {
  repo(on)

  const ran = await edit($, 'src/data/magicItems.ts', '"points": 100', '"points": 90')

  expect(ran.context?.join('\n')).toContain('mi-sword-of-death points: 100 -> 90')
})

test('a file that cannot be read is let through unchecked', async ($, on) => {
  const world = repo(on, { unreadable: new Set([EMPIRE]) })

  const ran = await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')
  await endTurn($)

  expect(world.allowed).toEqual([EMPIRE])
  expect(ran.context).toBeUndefined()
  expect(world.toasts).toEqual([])
})

test('if the guard itself breaks the edit still goes through', async ($, on) => {
  const world = repo(on, { isExistsBroken: true })

  const ran = await edit($, EMPIRE, 'pointsPerModel: 100,', 'pointsPerModel: 110,')

  expect(world.allowed).toEqual([EMPIRE])
  expect(ran.deny).toBeUndefined()
  expect(ran.isError).toBeUndefined()
})

test('the session start registers /citation-guard', async ($, on) => {
  const world = repo(on)

  await $.session.start({ cwd: '/w/warhammer', surface: 'desktop', isInteractive: true })

  expect(world.registered).toEqual(['citation-guard'])
})
