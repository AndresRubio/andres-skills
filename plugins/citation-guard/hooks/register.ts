import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change } from '../types'
import {
  EMPTY_LEDGER,
  applyEdit,
  cite,
  contextNote,
  diffNumbers,
  endTurn,
  hasTurnWork,
  kindOf,
  listText,
  mayMatter,
  record,
  toastText,
} from './logic'

type Engine = EngineInterface

// Change the tag when Ledger's fields change: it declines what an earlier
// version stored, which outlives a reload.
const ledger = atom({ plugin: 'citation-guard', key: 'ledger' } as const, EMPTY_LEDGER, { shape: 'ledger-1' })

// Where a folder sits in its git repo, kept per folder: `root` and `prefix`
// (the folder's path from the root, ending in a slash, empty at the root).
type Place = { root: string; prefix: string } | null
const places = new Map<string, Place>()

type Located = { abs: string; root: string; rel: string; kind: 'data' | 'citations' }

const dirname = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

// The deepest folder of `dir` that exists, and the names below it that do
// not yet (a Write may create folders).
const existingFolder = async ($: Engine, dir: string) => {
  const missing: string[] = []
  let base = dir
  while (base !== '/' && !(await $.fs.exists(base))) {
    missing.unshift(base.slice(base.lastIndexOf('/') + 1))
    base = dirname(base)
  }
  return { base, missing }
}

const placeOf = async ($: Engine, base: string): Promise<Place> => {
  if (places.has(base)) return places.get(base) ?? null
  let place: Place = null
  try {
    const found = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--show-prefix'], { cwd: base })
    const [root, prefix] = found.stdout.split('\n')
    if (found.exitCode === 0 && root) place = { root, prefix: prefix ?? '' }
  } catch {
    place = null
  }
  places.set(base, place)
  return place
}

// The file's repo, when it is the warhammer repo: its git root holds
// CITATIONS.md and package.json. Anything else is none, and the mod does
// nothing for it.
const locate = async ($: Engine, path: string): Promise<Located | undefined> => {
  const abs = path.startsWith('/') ? path : `${await $.session.cwd()}/${path}`
  if (!mayMatter(abs)) return undefined

  const { base, missing } = await existingFolder($, dirname(abs))
  const place = await placeOf($, base)
  if (place === null) return undefined

  const name = abs.slice(abs.lastIndexOf('/') + 1)
  const rel = [place.prefix.replace(/\/$/, ''), ...missing, name].filter(part => part !== '').join('/')
  const kind = kindOf(rel)
  if (kind === undefined) return undefined
  if (!(await $.fs.exists(`${place.root}/CITATIONS.md`)) || !(await $.fs.exists(`${place.root}/package.json`))) {
    return undefined
  }
  return { abs, root: place.root, rel, kind }
}

// The file as it is now: '' when it is not there yet, undefined when it
// cannot be read (then the edit goes unchecked).
const readBefore = async ($: Engine, path: string) => {
  try {
    return await $.fs.read(path)
  } catch {
    try {
      return (await $.fs.exists(path)) ? undefined : ''
    } catch {
      return undefined
    }
  }
}

const readAfter = async ($: Engine, path: string) => {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

// What an edit leaves in the file, if the file cannot be read back.
const simulate = (
  input: { tool: string; content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown },
  before: string,
) => {
  if (input.tool === 'Write') return typeof input.content === 'string' ? input.content : undefined
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return undefined
  return applyEdit(before, input.old_string, input.new_string, input.replace_all === true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'citation-guard',
      description: 'List the game value changes this session that CITATIONS.md has no entry for',
    })
    return started
  })

  on('tool.call', async ($, e, next) => {
    const input = e as {
      tool: string
      file_path?: unknown
      content?: unknown
      old_string?: unknown
      new_string?: unknown
      replace_all?: unknown
    }
    if ((input.tool !== 'Edit' && input.tool !== 'Write') || typeof input.file_path !== 'string') return next(e)
    const found = await locate($, input.file_path)
    if (found === undefined) return next(e)

    if (found.kind === 'citations') {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) await update($, ledger, cur => cite(cur, found.root))
      return ran
    }

    const before = await readBefore($, found.abs)
    const ran = await next(e)
    if (before === undefined || ran.deny !== undefined || ran.isError === true) return ran

    const after = (await readAfter($, found.abs)) ?? simulate(input, before)
    if (after === undefined) return ran
    const changes = diffNumbers(before, after)
    if (changes.length === 0) return ran

    let fresh: Change[] = []
    let isCited = false
    await update($, ledger, cur => {
      const recorded = record(cur, found.root, found.rel, changes)
      fresh = recorded.fresh
      isCited = cur.citedRoots.includes(found.root)
      return recorded.ledger
    })
    if (fresh.length === 0) return ran
    return { ...ran, context: [...(ran.context ?? []), contextNote(found.rel, fresh, isCited)] }
  }).catch(($, e, next) => {
    // The edit is not the guard's to stop: if the guard breaks, let it through.
    $.ui.log(`citation-guard: ${next.error?.message ?? 'failed'}`, { to: 'debug' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn is not the end of the main turn.
    if (e.agentId !== undefined) return result

    if (!hasTurnWork(await read($, ledger))) return result
    let report: ReturnType<typeof endTurn>['report'] = []
    await update($, ledger, cur => {
      const ended = endTurn(cur)
      report = ended.report
      return ended.ledger
    })
    if (report.length > 0) $.ui.toast(toastText(report))
    return result
  })

  on('command.run', { command: 'citation-guard' }, async $ => ({ text: listText(await read($, ledger)) }))
}
