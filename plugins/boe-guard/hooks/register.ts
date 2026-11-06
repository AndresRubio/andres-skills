import type { EngineInterface, Register } from 'claude-code'

import {
  absolutePath,
  basename,
  couldBeProtected,
  dirname,
  dumpDeny,
  dumpTargets,
  findLoads,
  globHitsProtected,
  hasGlob,
  kindOfRel,
  limitProblem,
  loadReason,
  mayDump,
  mayLoad,
  readDeny,
  splitGlob,
} from './logic'
import type { Kind, Load } from './logic'

type Engine = EngineInterface

// The repo is the git root named boe-agent, or any checkout holding this
// file (a worktree or a clone under another name has it too).
const REPO_NAME = 'boe-agent'
const REPO_MARKER = 'src/boe_agent/comandos/barrido_boe.py'

// The shell's folder as the engine last reported it. A `cd` in one Bash
// call outlives the call, and the session folder does not follow it.
let shellCwd: string | undefined

// Where a folder sits in its git repo: the root, and the folder's own path
// under it (empty at the root, else ending in a slash). Undefined outside
// any repo. Git reports the prefix itself, so a symlinked spelling of the
// path still lands on the right file.
const placeOf = async ($: Engine, dir: string) => {
  if (!(await $.fs.exists(dir))) return undefined
  const found = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--show-prefix'], { cwd: dir })
  if (found.exitCode !== 0) return undefined
  const [root, prefix = ''] = found.stdout.split('\n')
  return root ? { root, prefix } : undefined
}

const isBoeAgent = async ($: Engine, root: string) =>
  basename(root) === REPO_NAME || (await $.fs.exists(`${root}/${REPO_MARKER}`))

// The folders a relative path or a `cd` may start from.
const startDirs = async ($: Engine) => {
  const session = await $.session.cwd()
  return shellCwd !== undefined && shellCwd !== session ? [shellCwd, session] : [session]
}

const home = async ($: Engine) => (await $.env.get('HOME')) ?? ''

// The refusal text for a Read of PROGRESS.md or a plan with no usable
// `limit`; undefined for any other call.
const readDenial = async ($: Engine, e: { file_path?: unknown; limit?: unknown }) => {
  if (typeof e.file_path !== 'string') return undefined
  const problem = limitProblem(e.limit)
  if (problem === undefined) return undefined

  const [cwd = '/'] = await startDirs($)
  const path = absolutePath(e.file_path, { cwd, home: await home($) })
  // The path as written, and where it really leads (a link to PROGRESS.md).
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  const spellings = stat?.realPath !== undefined && stat.realPath !== path ? [path, stat.realPath] : [path]

  for (const spelling of spellings) {
    if (!couldBeProtected(spelling)) continue
    const place = await placeOf($, dirname(spelling))
    if (place === undefined || !(await isBoeAgent($, place.root))) continue
    const rel = place.prefix + basename(spelling)
    const kind = kindOfRel(rel)
    if (kind !== undefined) return { text: readDeny(kind, rel, problem), name: basename(spelling) }
  }
  return undefined
}

// The refusal text for a Bash command that prints PROGRESS.md or a plan
// whole; undefined when it prints neither.
const dumpDenial = async ($: Engine, command: string) => {
  if (!mayDump(command)) return undefined
  const homeDir = await home($)
  const seen = new Set<string>()
  for (const cwd of await startDirs($)) {
    for (const target of dumpTargets(command, { cwd, home: homeDir })) {
      if (seen.has(target)) continue
      seen.add(target)
      if (!couldBeProtected(target)) continue

      if (hasGlob(target)) {
        const { dir, rest } = splitGlob(target)
        const place = await placeOf($, dir)
        if (place === undefined || !(await isBoeAgent($, place.root))) continue
        const names = await $.fs.list(`${place.root}/docs/superpowers/plans`).catch(() => [])
        if (globHitsProtected(place.prefix + rest, names.map(n => n.name))) {
          const kind: Kind = kindOfRel(place.prefix + rest) ?? 'progress'
          return { text: dumpDeny(kind, `${place.prefix}${rest}`), name: rest }
        }
        continue
      }

      const place = await placeOf($, dirname(target))
      if (place === undefined || !(await isBoeAgent($, place.root))) continue
      const rel = place.prefix + basename(target)
      const kind = kindOfRel(rel)
      if (kind !== undefined) return { text: dumpDeny(kind, rel), name: basename(target) }
    }
  }
  return undefined
}

// The loads in a command that run in the boe-agent repo.
const loadsIn = async ($: Engine, command: string) => {
  if (!mayLoad(command)) return []
  const homeDir = await home($)
  const found = new Map<string, Load>()
  for (const cwd of await startDirs($)) {
    for (const load of findLoads(command, { cwd, home: homeDir })) {
      const place = await placeOf($, load.dir)
      if (place !== undefined && (await isBoeAgent($, place.root))) {
        found.set(JSON.stringify({ ...load, dir: '' }), load)
      }
    }
  }
  return [...found.values()]
}

const refusedToast = ($: Engine, name: string) =>
  $.ui.toast(`boe-guard: Claude tried to read all of ${name}; it was told to read one section instead.`)

export const register: Register = on => {
  // A `cd` in a Bash call moves the shell for the calls after it.
  on('classic.CwdChanged', ($, e, next) => {
    shellCwd = e.new_cwd
    return next(e)
  })

  // Read guard. It fails closed: if the guard itself breaks, the read stops.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const denial = await readDenial($, e as { file_path?: unknown; limit?: unknown })
    if (denial === undefined) return next(e)
    refusedToast($, denial.name)
    return { deny: denial.text }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          deny: `boe-guard: the read guard failed (${next.error?.message ?? 'no reason given'}), so this Read was stopped. Tell the user, or read the file with a small \`limit\`.`,
        },
  )

  // Dump guard: cat, less or more of the same files, with no narrowing pipe.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (typeof e.command !== 'string') return next(e)
    const denial = await dumpDenial($, e.command)
    if (denial === undefined) return next(e)
    refusedToast($, denial.name)
    return { deny: denial.text }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          deny: `boe-guard: the dump guard failed (${next.error?.message ?? 'no reason given'}), so this command was stopped. Tell the user, or print only part of the file.`,
        },
  )

  // Load confirmation. A hook's `ask` goes to the person in the permission
  // dialog, with this reason on it; no mode or saved rule settles it. Where
  // nobody can be asked, the engine refuses and the model reads the reason.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e.input as { command?: unknown } | null | undefined)?.command
    if (typeof command !== 'string') return next(e)
    const loads = await loadsIn($, command)
    if (loads.length === 0) return next(e)
    const verdict = await next(e)
    return verdict.decision === 'deny' ? verdict : { decision: 'ask', reason: loadReason(loads) }
  }).catch(($, e, next) => ({
    decision: 'deny',
    reason: `boe-guard: its load check failed (${next.error?.message ?? 'no reason given'}), so this command was stopped. If it loads BDNS or BOE data, ask the user in chat to confirm the source and month first.`,
  }))
}
