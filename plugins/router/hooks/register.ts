import type { EngineInterface, Register } from 'claude-code'

import {
  BUILT_IN,
  agentOf,
  denyFailed,
  denyMissing,
  denyUnknown,
  gaps,
  installPaths,
  isFork,
  openIn,
  pluginType,
  projectDirs,
  routesOf,
  typeOf,
} from './logic'
import type { Definition, Route } from './logic'

type Engine = EngineInterface

// One lookup reads at most this many agent files. A folder with more is not
// searched to the end, and the check then fails closed.
const MAX_FILES = 300

type Budget = { left: number }

// Claude Code's own folder: CLAUDE_CONFIG_DIR, else ~/.claude.
const configDir = async ($: Engine): Promise<string> => {
  const set = await $.env.get('CLAUDE_CONFIG_DIR')
  if (set !== undefined && set !== '') return set
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') throw new Error('HOME is not set, so ~/.claude can\'t be found')
  return `${home}/.claude`
}

// The repository root above `cwd`, or undefined outside a repository.
const repoRoot = async ($: Engine, cwd: string): Promise<string | undefined> => {
  const found = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  const root = found.stdout.trim()
  return found.exitCode === 0 && root !== '' ? root : undefined
}

// The definition of the agent called `name` among the `.md` files of `dir`, and
// of its subfolders when `deep`. Undefined when `dir` is missing or has none.
// A link is not followed.
const findIn = async (
  $: Engine,
  dir: string,
  name: string,
  deep: boolean,
  budget: Budget,
): Promise<Definition | undefined> => {
  if (!(await $.fs.exists(dir))) return undefined
  const entries = [...(await $.fs.list(dir))].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    budget.left -= 1
    if (budget.left < 0) throw new Error(`more than ${MAX_FILES} agent files to read`)
    const agent = agentOf(await $.fs.read(`${dir}/${entry.name}`), entry.name)
    if (agent.name === name) return agent.definition
  }
  if (!deep) return undefined
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const found = await findIn($, `${dir}/${entry.name}`, name, deep, budget)
    if (found !== undefined) return found
  }
  return undefined
}

// Where a plugin's files are: this plugin's own folder, else each folder
// installed_plugins.json lists for it.
const pluginRoots = async ($: Engine, plugin: string): Promise<string[]> => {
  if (plugin === $.plugin.name) return [$.plugin.root]
  const file = `${await configDir($)}/plugins/installed_plugins.json`
  if (!(await $.fs.exists(file))) return []
  return installPaths(await $.fs.read(file), plugin)
}

// What the agent type fixes, or undefined when no definition of it can be read.
// The order is Claude Code's: a plugin's type by its name, and for a plain type
// the project's files, the user's, then the built-in types.
const definitionOf = async ($: Engine, type: string): Promise<Definition | undefined> => {
  const budget: Budget = { left: MAX_FILES }
  const scoped = pluginType(type)
  if (scoped !== undefined) {
    for (const root of await pluginRoots($, scoped.plugin)) {
      const dir = [root, 'agents', ...scoped.folders].join('/')
      const found = await findIn($, dir, scoped.name, false, budget)
      if (found !== undefined) return found
    }
    return undefined
  }

  const cwd = await $.session.cwd()
  for (const dir of projectDirs(cwd, await repoRoot($, cwd))) {
    const found = await findIn($, `${dir}/.claude/agents`, type, true, budget)
    if (found !== undefined) return found
  }
  const own = await findIn($, `${await configDir($)}/agents`, type, true, budget)
  return own ?? BUILT_IN[type]
}

// This plugin's own agents, for a refusal to offer.
const ownRoutes = async ($: Engine): Promise<Route[]> => {
  const dir = `${$.plugin.root}/agents`
  const agents = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind === 'file' && entry.name.endsWith('.md')) agents.push(agentOf(await $.fs.read(`${dir}/${entry.name}`), entry.name))
  }
  return routesOf(agents)
}

export const register: Register = on => {
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // The fields are read by name and checked before use (docs/mods.md, rule 3).
    const call: Record<string, unknown> = e
    const open = openIn(call)
    if (isFork(call) || open.length === 0) return next(e)

    const type = typeOf(call)
    const definition = await definitionOf($, type)
    if (definition === undefined) return { deny: denyUnknown($.plugin.name, type, open, await ownRoutes($)) }
    const missing = gaps(open, definition)
    if (missing.length === 0) return next(e)
    return { deny: denyMissing($.plugin.name, type, missing, missing.includes('model') ? await ownRoutes($) : []) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: denyFailed($.plugin.name, next.error?.message) }))
}
