// The router's rules as pure functions: what an Agent call leaves open, what an
// agent definition fixes, and the text of each refusal. register.ts does the
// file reading and hands the results here.

// What a call or an agent definition can fix about a subagent's run.
export type Setting = 'model' | 'effort'
export const SETTINGS: readonly Setting[] = ['model', 'effort']

// What a definition fixes. A missing key means the run would take the session's.
export type Definition = { model?: string; effort?: string }

// A fork copies its parent's conversation, model and effort, and the Agent tool
// ignores `model` and `effort` on it.
export const FORK = 'fork'
// The type the Agent tool runs when the call names none.
export const DEFAULT_TYPE = 'general-purpose'

// The agent types Claude Code ships, and what each fixes, from the Built-in
// subagents section of https://code.claude.com/docs/en/sub-agents.md as it stood
// for 2.1.317. None of them sets an effort. A file named like one of these in
// `.claude/agents` or `~/.claude/agents` replaces it, so files are looked up first.
export const BUILT_IN: Readonly<Record<string, Definition>> = {
  'general-purpose': {},
  Explore: {},
  Plan: {},
  claude: {},
  'statusline-setup': { model: 'sonnet' },
  'claude-code-guide': { model: 'haiku' },
}

// One of this plugin's own agents, as a refusal lists it: what it fixes and its
// description, which says when to pick it.
export type Route = { agent: string; model: string; effort: string; description: string }

// Cheapest first, the order of the routing table.
const MODEL_ORDER = ['haiku', 'sonnet', 'opus', 'fable']

const isSet = (value: unknown): boolean =>
  (typeof value === 'string' && value.trim() !== '') || typeof value === 'number'

// The agent type a call runs: its `subagent_type`, else the default type.
export function typeOf(call: Readonly<Record<string, unknown>>): string {
  const type = call.subagent_type
  return typeof type === 'string' && type.trim() !== '' ? type.trim() : DEFAULT_TYPE
}

export const isFork = (call: Readonly<Record<string, unknown>>): boolean => typeOf(call) === FORK

// The settings the call itself leaves open.
export function openIn(call: Readonly<Record<string, unknown>>): Setting[] {
  return SETTINGS.filter(setting => !isSet(call[setting]))
}

// The settings neither the call nor the definition fixes.
export function gaps(open: readonly Setting[], definition: Definition): Setting[] {
  return open.filter(setting => definition[setting] === undefined)
}

// The top-level `key: value` lines of a file's frontmatter, or undefined when
// the file has none. Values lose their quotes and a trailing comment. Nested
// keys and lists are skipped: the router reads only name, description, model and effort.
export function frontmatter(text: string): Record<string, string> | undefined {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) return undefined

  const fields: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const found = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (found === null) continue
    const [, key = '', raw = ''] = found
    const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(raw.trim())
    fields[key] = quoted !== null ? (quoted[2] ?? '') : raw.replace(/\s+#.*$/, '').trim()
  }
  return fields
}

// An agent file's name, description and what it fixes. `model: inherit` fixes
// nothing: it names the session's model, which is what the router is there to
// stop. The name falls back to the file's own, as Claude Code does for a
// plugin's agent.
export function agentOf(text: string, fileName: string): { name: string; description: string; definition: Definition } {
  const fields = frontmatter(text) ?? {}
  const definition: Definition = {}
  if (fields.model !== undefined && fields.model !== '' && fields.model !== 'inherit') definition.model = fields.model
  if (fields.effort !== undefined && fields.effort !== '') definition.effort = fields.effort
  const ownName = fields.name !== undefined && fields.name !== '' ? fields.name : fileName.replace(/\.md$/, '')
  return { name: ownName, description: fields.description ?? '', definition }
}

// The agents a refusal offers, from this plugin's own agent files: the ones
// that fix both settings, cheapest model first.
export function routesOf(agents: readonly { name: string; description: string; definition: Definition }[]): Route[] {
  const tier = (model: string): number => {
    const at = MODEL_ORDER.indexOf(model)
    return at === -1 ? MODEL_ORDER.length : at
  }
  return agents
    .flatMap(({ name, description, definition: { model, effort } }) =>
      model !== undefined && effort !== undefined ? [{ agent: name, model, effort, description }] : [],
    )
    .sort((a, b) => tier(a.model) - tier(b.model) || a.agent.localeCompare(b.agent))
}

// A plugin's agent type, `<plugin>:<folder>:...:<name>`, taken apart. Undefined
// for a type with no colon, which is a project, user or built-in agent.
export function pluginType(type: string): { plugin: string; folders: string[]; name: string } | undefined {
  const parts = type.split(':')
  const [plugin, ...rest] = parts
  const name = rest.pop()
  if (plugin === undefined || name === undefined || parts.some(part => part === '')) return undefined
  return { plugin, folders: rest, name }
}

// The folders whose `.claude/agents` Claude Code reads for a session in `cwd`:
// each one from `cwd` up to the repository's root, nearest first. Outside a
// repository, or when `cwd` is not under `root`, `cwd` alone.
export function projectDirs(cwd: string, root: string | undefined): string[] {
  const start = cwd.replace(/\/+$/, '') || '/'
  const top = root?.replace(/\/+$/, '')
  if (top === undefined || top === '' || !(start === top || start.startsWith(`${top}/`))) return [start]
  const dirs = [start]
  let dir = start
  while (dir !== top) {
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
    dirs.push(dir)
  }
  return dirs
}

// The install folders of a plugin, from the text of Claude Code's
// installed_plugins.json: every `installPath` under a `<plugin>@<marketplace>`
// key. Empty when the plugin is not there. Throws on text that is not that file.
export function installPaths(json: string, plugin: string): string[] {
  const plugins = fieldOf(JSON.parse(json), 'plugins')
  if (typeof plugins !== 'object' || plugins === null) throw new Error('installed_plugins.json has no "plugins" object')
  const paths: string[] = []
  for (const [key, installs] of Object.entries(plugins)) {
    if (!key.startsWith(`${plugin}@`) || !Array.isArray(installs)) continue
    for (const install of installs) {
      const path = fieldOf(install, 'installPath')
      if (typeof path === 'string' && path !== '' && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  // TypeScript can't narrow parsed JSON to "an object with this key", so the cast reads it.
  return (value as Record<string, unknown>)[key]
}

const named = (settings: readonly Setting[]): string => settings.map(setting => `\`${setting}\``).join(' and ')
const plain = (settings: readonly Setting[]): string => settings.join(' and no ')

function routeLines(plugin: string, routes: readonly Route[]): string {
  return routes.map(route => `- \`${plugin}:${route.agent}\` (${route.model}, ${route.effort}): ${route.description}`).join('\n')
}

const EFFORTS =
  'Effort: "medium" for ordinary work, "high" for bug fixes and edge-case-heavy work, "low" for a batch a script can check.'

// The refusal for a call whose agent type was found and leaves `missing` open.
export function denyMissing(plugin: string, type: string, missing: readonly Setting[], routes: readonly Route[]): string {
  const head =
    `${plugin}: this Agent call sets no ${plain(missing)}, and neither does its agent type \`${type}\`, ` +
    `so the subagent would take the session's.`
  if (!missing.includes('model')) return `${head} Call it again with \`effort\` on the call. ${EFFORTS}`
  return (
    `${head} Choose by the task and call it again, with one of these agents as \`subagent_type\` ` +
    `or with ${named(missing)} on the call:\n\n${routeLines(plugin, routes)}\n\n` +
    `\`model\` and \`effort\` on the call win over the agent's own, so a harder task can keep its agent ` +
    `and raise one of them. ${EFFORTS} A call with \`subagent_type: "fork"\` is not checked.`
  )
}

// The refusal for a call whose agent type has no definition the router can read.
export function denyUnknown(plugin: string, type: string, open: readonly Setting[], routes: readonly Route[]): string {
  return (
    `${plugin}: this Agent call sets no ${plain(open)}, and the definition of its agent type \`${type}\` could not be ` +
    `found, so the check can't tell whether the type sets its own. The type may come from \`--agents\`, managed ` +
    `settings or a plugin loaded from a folder. Call it again with ${named(open)} on the call. If the type has its ` +
    `own, repeat those values. Otherwise choose by the task:\n\n${routeLines(plugin, routes)}`
  )
}

// The refusal when the check itself failed.
export function denyFailed(plugin: string, reason: string | undefined): string {
  return (
    `${plugin}: the check of this Agent call's model and effort failed (${reason ?? 'no reason given'}), so the call ` +
    `was stopped. Call it again with \`model\` and \`effort\` on the call, which needs no lookup.`
  )
}
