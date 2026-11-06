import type { Quote, Reminder, TrackedRun } from '../types'

// ---------------------------------------------------------------------------
// Shell commands: where forja runs in a Bash command, and with what.
// ---------------------------------------------------------------------------

type Token = { kind: 'word'; text: string } | { kind: 'op'; text: string }

const OPERATORS = ['&&', '||', '|&', ';;', '&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '>>', '>&', '>|', '|', '&', ';', '(', ')', '<', '>']

// Reads `$( ... )` or `` ` ... ` `` whole, so what is inside stays one word.
function skipSubstitution(command: string, start: number): number {
  if (command.charAt(start) === '`') {
    const end = command.indexOf('`', start + 1)
    return end === -1 ? command.length : end + 1
  }
  let depth = 0
  for (let i = start; i < command.length; i++) {
    const c = command.charAt(i)
    if (c === '\\') i += 1
    else if (c === "'") i = command.indexOf("'", i + 1) === -1 ? command.length : command.indexOf("'", i + 1)
    else if (c === '(') depth += 1
    else if (c === ')' && --depth === 0) return i + 1
  }
  return command.length
}

// Splits a command into words (quotes removed) and operators. Good enough for
// the commands a model writes; heredoc bodies are read as more commands.
export function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  const flush = () => {
    if (inWord) tokens.push({ kind: 'word', text: word })
    word = ''
    inWord = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i)
    if (c === '\\') {
      if (command.charAt(i + 1) === '\n') {
        i += 1
        continue
      }
      word += command.charAt(i + 1)
      inWord = true
      i += 1
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      word += command.slice(i + 1, end === -1 ? undefined : end)
      inWord = true
      i = end === -1 ? command.length : end
    } else if (c === '"') {
      inWord = true
      for (i += 1; i < command.length && command.charAt(i) !== '"'; i++) {
        const d = command.charAt(i)
        if (d === '\\' && '"\\$`\n'.includes(command.charAt(i + 1))) {
          i += 1
          if (command.charAt(i) !== '\n') word += command.charAt(i)
        } else if (d === '$' && command.charAt(i + 1) === '(') {
          const end = skipSubstitution(command, i + 1)
          word += command.slice(i, end)
          i = end - 1
        } else {
          word += d
        }
      }
    } else if ((c === '$' && command.charAt(i + 1) === '(') || c === '`') {
      const start = c === '`' ? i : i + 1
      const end = skipSubstitution(command, start)
      word += command.slice(i, end)
      inWord = true
      i = end - 1
    } else if (c === '<' && command.charAt(i + 1) === '(') {
      const end = skipSubstitution(command, i + 1)
      word += command.slice(i, end)
      inWord = true
      i = end - 1
    } else if (c === '#' && !inWord) {
      const end = command.indexOf('\n', i)
      i = (end === -1 ? command.length : end) - 1
    } else if (c === ' ' || c === '\t') {
      flush()
    } else if (c === '\n') {
      flush()
      tokens.push({ kind: 'op', text: '\n' })
    } else {
      const op = OPERATORS.find(o => command.startsWith(o, i))
      if (op === undefined) {
        word += c
        inWord = true
        continue
      }
      // `2>`, `0<`: a file descriptor number written against its redirect.
      const fd = /^\d+$/.test(word) && (op.startsWith('<') || op.startsWith('>')) ? word : undefined
      if (fd !== undefined) {
        word = ''
        inWord = false
      } else {
        flush()
      }
      tokens.push({ kind: 'op', text: fd === undefined ? op : `${fd}${op}` })
      i += op.length - 1
    }
  }
  flush()
  return tokens
}

type Segment = { words: string[]; isStdinFed: boolean }

const SEPARATORS = new Set(['&&', '||', '|&', '|', ';;', ';', '&', '\n', '(', ')'])

function segments(command: string): Segment[] {
  const out: Segment[] = []
  let current: Segment = { words: [], isStdinFed: false }
  // The next word is a redirect's target: 'stdin' when it feeds stdin.
  let target: 'stdin' | 'other' | undefined
  for (const token of tokenize(command)) {
    if (token.kind === 'word') {
      // `< /dev/null` gives the same end of input the Bash tool does.
      if (target === 'stdin' && token.text !== '/dev/null') current.isStdinFed = true
      if (target === undefined) current.words.push(token.text)
      target = undefined
      continue
    }
    if (SEPARATORS.has(token.text)) {
      out.push(current)
      current = { words: [], isStdinFed: token.text === '|' || token.text === '|&' }
      target = undefined
      continue
    }
    // A redirect: its target is no argument. `<`, `<<`, `<<<` and `0<` feed stdin.
    target = /^0?(<|<<|<<<|<<-|<>)$/.test(token.text) ? 'stdin' : 'other'
    if (token.text.includes('<<')) current.isStdinFed = true
  }
  out.push(current)
  return out.filter(segment => segment.words.length > 0)
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

export function dirname(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

// Joins and tidies an absolute path; `p` may be absolute already.
export function joinPath(base: string, p: string): string {
  const parts: string[] = []
  for (const part of (p.startsWith('/') ? p : `${base}/${p}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time', 'nohup', 'command', 'exec', 'builtin'])
const WRAPPERS = new Set(['caffeinate', 'env', 'nice', 'stdbuf', 'unbuffer', 'sudo', 'script'])
const TIMEOUTS = new Set(['timeout', 'gtimeout'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const UV_VALUE_OPTIONS = new Set([
  '--project', '--directory', '--with', '--with-requirements', '--with-editable', '--python', '-p',
  '--env-file', '--extra', '--group', '--package', '--from', '--index', '--default-index', '--index-url',
])

export type Invocation = {
  // The forja subcommand (`run`, `cleanup`, ...), or '' when none.
  sub: string
  args: string[]
  // `cd` targets met earlier in the command, in order.
  cds: string[]
  // A pipe or a redirect feeds forja's stdin, so its own question can be answered.
  isStdinFed: boolean
}

function skipUvOptions(words: readonly string[], start: number): number {
  let j = start
  while (j < words.length && (words[j] ?? '').startsWith('-')) {
    const word = words[j] ?? ''
    if (word === '--') return j + 1
    j += UV_VALUE_OPTIONS.has(word) ? 2 : 1
  }
  return j
}

// The forja arguments a segment's words run, or undefined.
function forjaArgs(words: readonly string[]): { args: string[]; script?: undefined } | { script: string; args?: undefined } | undefined {
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    const name = basename(word)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || KEYWORDS.has(word) || word === '-p') {
      i += 1
    } else if (WRAPPERS.has(name)) {
      i += 1
      while (i < words.length && /^-|^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i += 1
    } else if (TIMEOUTS.has(name)) {
      i += 1
      while (i < words.length && (words[i] ?? '').startsWith('-')) i += 1
      i += 1
    } else if (SHELLS.has(name)) {
      const flag = words.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w))
      const script = flag === -1 ? undefined : words[flag + 1]
      return script === undefined ? undefined : { script }
    } else if (name === 'eval') {
      return { script: words.slice(i + 1).join(' ') }
    } else if (name === 'forja') {
      return { args: words.slice(i + 1) }
    } else if (name === 'uv') {
      let j = i + 1
      if (words[j] === 'tool') j += 1
      if (words[j] !== 'run') return undefined
      j = skipUvOptions(words, j + 1)
      return basename(words[j] ?? '') === 'forja' ? { args: words.slice(j + 1) } : undefined
    } else if (name === 'uvx') {
      const j = skipUvOptions(words, i + 1)
      return /^forja(@|$)/.test(words[j] ?? '') ? { args: words.slice(j + 1) } : undefined
    } else {
      return undefined
    }
  }
  return undefined
}

// Every forja invocation in a Bash command, with the `cd`s before it. Reads
// the command's text, so it misses forja behind an alias, a variable or a
// script file.
export function findForja(command: string, depth = 0): Invocation[] {
  const found: Invocation[] = []
  const cds: string[] = []
  const nested = (script: string, isStdinFed: boolean) => {
    if (depth >= 3) return
    for (const inner of findForja(script, depth + 1)) {
      found.push({ ...inner, cds: [...cds, ...inner.cds], isStdinFed: inner.isStdinFed || isStdinFed })
    }
  }
  for (const segment of segments(command)) {
    // `$( ... )` and backticks inside any word run commands of their own.
    for (const word of segment.words) {
      for (const m of word.matchAll(/\$\(([\s\S]*)\)|`([^`]*)`/g)) nested(m[1] ?? m[2] ?? '', false)
    }
    const first = segment.words[0]
    if (first === 'cd' || first === 'pushd') {
      cds.push(segment.words[1] ?? '~')
      continue
    }
    const hit = forjaArgs(segment.words)
    if (hit?.script !== undefined) {
      nested(hit.script, segment.isStdinFed)
    } else if (hit?.args !== undefined) {
      const sub = hit.args[0] !== undefined && !hit.args[0].startsWith('-') ? hit.args[0] : ''
      found.push({ sub, args: sub === '' ? hit.args : hit.args.slice(1), cds: [...cds], isStdinFed: segment.isStdinFed })
    }
  }
  return found
}

export type RunArgs = {
  config?: string
  sets: string[]
  isYes: boolean
  out?: string
  isKeepOnFailure: boolean
  isHelp: boolean
}

// `forja run`'s options as click reads them: anywhere on the line, `--set`
// and `--out` with a value (separate or after `=`).
export function parseRunArgs(args: readonly string[]): RunArgs {
  const parsed: RunArgs = { sets: [], isYes: false, isKeepOnFailure: false, isHelp: false }
  let isPositional = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (isPositional || !arg.startsWith('-') || arg === '-') {
      parsed.config ??= arg
    } else if (arg === '--') {
      isPositional = true
    } else if (arg === '--yes') {
      parsed.isYes = true
    } else if (arg === '--keep-on-failure') {
      parsed.isKeepOnFailure = true
    } else if (arg === '--help') {
      parsed.isHelp = true
    } else if (arg === '--set' || arg === '--out') {
      const value = args[i + 1]
      i += 1
      if (value === undefined) continue
      if (arg === '--set') parsed.sets.push(value)
      else parsed.out = value
    } else if (arg.startsWith('--set=')) {
      parsed.sets.push(arg.slice(6))
    } else if (arg.startsWith('--out=')) {
      parsed.out = arg.slice(6)
    }
  }
  return parsed
}

export type CleanupArgs = { provider?: string; isYes: boolean }

export function parseCleanupArgs(args: readonly string[]): CleanupArgs {
  const parsed: CleanupArgs = { isYes: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--yes') parsed.isYes = true
    else if (arg === '--provider') parsed.provider = args[++i]
    else if (arg.startsWith('--provider=')) parsed.provider = arg.slice(11)
  }
  return parsed
}

export type ForjaRun = { invocation: Invocation; args: RunArgs }

// Commands that only print or search text: `forja run --yes` in their
// arguments starts nothing.
const TEXT_COMMANDS = new Set(['echo', 'printf', 'cat', 'grep', 'rg', 'egrep', 'sed', 'awk', 'head', 'tail', 'less', 'man', 'which', 'type', 'ls', 'git', 'gh', 'wc', 'sort'])

// A `forja ... run ... --yes` the reader could not place: forja handed to
// another program (`xargs`, `watch`, `parallel`, `ssh`), so it is asked about too.
function isUnplaced(command: string): boolean {
  return segments(command).some(({ words }) => {
    if (TEXT_COMMANDS.has(basename(words[0] ?? ''))) return false
    const at = words.findIndex(word => basename(word) === 'forja' || /^forja@/.test(word))
    return at !== -1 && words.indexOf('run', at) !== -1 && words.includes('--yes') && !words.includes('--help')
  })
}

// The `forja run`s in a command that start without forja's own cost question:
// `--yes`, or a stdin that answers it.
export function runsNeedingConfirmation(command: string): { runs: ForjaRun[]; isUnparsed: boolean } {
  const runs = findForja(command)
    .filter(invocation => invocation.sub === 'run')
    .map(invocation => ({ invocation, args: parseRunArgs(invocation.args) }))
    .filter(run => !run.args.isHelp && run.args.config !== undefined && (run.args.isYes || run.invocation.isStdinFed))
  return { runs, isUnparsed: runs.length === 0 && isUnplaced(command) }
}

// Whether a tool.check input is a Bash command the cost guard must judge.
// When the reading itself fails, it is: the guard fails closed.
export function isGuarded(input: unknown): boolean {
  const command = child(input, 'command')
  if (typeof command !== 'string') return false
  try {
    const found = runsNeedingConfirmation(command)
    return found.runs.length > 0 || found.isUnparsed
  } catch {
    return /\bforja\b/.test(command)
  }
}

// ---------------------------------------------------------------------------
// The config: a small YAML reader for the keys the cost depends on.
// ---------------------------------------------------------------------------

function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i)
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
      return line.slice(0, i).replace(/\s+$/, '')
    }
  }
  return line.replace(/\s+$/, '')
}

function splitFlow(inner: string): string[] {
  const items: string[] = []
  let quote = ''
  let depth = 0
  let current = ''
  for (const c of inner) {
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '[' || c === '{') {
      depth += 1
    } else if (c === ']' || c === '}') {
      depth -= 1
    } else if (c === ',' && depth === 0) {
      items.push(current)
      current = ''
      continue
    }
    current += c
  }
  if (current.trim() !== '') items.push(current)
  return items
}

// One YAML scalar or flow list, as PyYAML's safe_load reads the common cases.
export function parseScalar(text: string): unknown {
  const value = text.trim()
  if (value.startsWith('[') && value.endsWith(']')) return splitFlow(value.slice(1, -1)).map(parseScalar)
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return Number(value)
  if (/^(true|True|TRUE)$/.test(value)) return true
  if (/^(false|False|FALSE)$/.test(value)) return false
  if (value === '' || value === '~' || /^(null|Null|NULL)$/.test(value)) return null
  return value
}

type Frame = { indent: number; map: Record<string, unknown> } | { indent: number; list: unknown[] }

// Block mappings, block lists of scalars, flow lists and scalars: what a forja
// config uses. Anything else reads as missing, never as a wrong value.
export function parseYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  const stack: Frame[] = [{ indent: -1, map: root }]
  let pending: { key: string; parent: Record<string, unknown>; indent: number } | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw)
    if (line.trim() === '' || /^(---|\.\.\.)\s*$/.test(line)) continue
    const indent = line.length - line.trimStart().length
    const content = line.trim()
    const isItem = content === '-' || content.startsWith('- ')
    if (pending !== undefined) {
      if (isItem && indent >= pending.indent) {
        const list: unknown[] = []
        pending.parent[pending.key] = list
        stack.push({ indent, list })
      } else if (indent > pending.indent) {
        const map: Record<string, unknown> = {}
        pending.parent[pending.key] = map
        stack.push({ indent, map })
      } else {
        pending.parent[pending.key] = null
      }
      pending = undefined
    }
    for (;;) {
      const top = stack[stack.length - 1]
      if (top === undefined || stack.length === 1) break
      if (top.indent > indent || (top.indent === indent && 'list' in top && !isItem)) stack.pop()
      else break
    }
    const top = stack[stack.length - 1]
    if (top === undefined) break
    if (isItem) {
      if ('list' in top) top.list.push(parseScalar(content.slice(1)))
      continue
    }
    if (!('map' in top)) continue
    const match = /^((?:"[^"]*"|'[^']*'|[^:])+?):(?:\s+(.*))?$/.exec(content)
    if (match === null) continue
    const key = String(parseScalar(match[1] ?? ''))
    const rest = (match[2] ?? '').trim()
    if (rest === '') pending = { key, parent: top.map, indent }
    else top.map[key] = parseScalar(rest)
  }
  if (pending !== undefined) pending.parent[pending.key] = null
  return root
}

// Applies forja's `--set dotted.key=yaml_value` overrides; a bad one is skipped
// (forja itself refuses it with exit 2, before creating anything).
export function applySets(raw: Record<string, unknown>, sets: readonly string[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
  for (const item of sets) {
    const cut = item.indexOf('=')
    if (cut <= 0) continue
    const keys = item.slice(0, cut).trim().split('.')
    let node = copy
    for (const key of keys.slice(0, -1)) {
      const child = node[key]
      if (child === undefined || child === null) node = node[key] = {}
      else if (typeof child === 'object' && !Array.isArray(child)) node = child as Record<string, unknown>
      else break
    }
    const last = keys[keys.length - 1]
    if (last !== undefined) node[last] = parseScalar(item.slice(cut + 1))
  }
  return copy
}

export type RunSettings = { project?: string; provider?: string; gpus: string[]; maxHours?: number }

const child = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined

// The settings the cost depends on, with forja's defaults (gpu L4, 1 hour).
export function runSettings(raw: Record<string, unknown>): RunSettings {
  const runner = child(child(raw, 'train'), 'runner')
  const gpu = child(runner, 'gpu')
  const gpus = gpu === undefined || gpu === null ? ['L4'] : (Array.isArray(gpu) ? gpu : [gpu]).map(String)
  const rawHours = child(runner, 'max_hours')
  // pydantic reads a numeric string as a number too.
  const hours = typeof rawHours === 'string' && rawHours.trim() !== '' ? Number(rawHours) : rawHours
  const project = child(raw, 'project')
  const provider = child(runner, 'provider')
  return {
    project: typeof project === 'string' ? project : undefined,
    provider: typeof provider === 'string' ? provider : undefined,
    gpus,
    maxHours: hours === undefined || hours === null ? 1 : typeof hours === 'number' && hours > 0 && hours <= 24 ? hours : undefined,
  }
}

// ---------------------------------------------------------------------------
// Prices and cost, as forja's pricing.py computes them.
// ---------------------------------------------------------------------------

export type PriceTable = { asOf: string; prices: Readonly<Record<string, number>> }

// Copied from forja's src/forja/pricing.py; read from the repo when it is there.
export const BUILTIN_MODAL_PRICES: PriceTable = {
  asOf: '2026-10-05',
  prices: {
    T4: 0.59,
    L4: 0.8,
    A10G: 1.1,
    L40S: 1.95,
    'A100-40GB': 2.1,
    'A100-80GB': 2.5,
    H100: 3.95,
    H200: 4.54,
    B200: 6.25,
  },
}

export function parsePricing(text: string): PriceTable | undefined {
  const asOf = /MODAL_PRICES_AS_OF\s*=\s*["']([^"']+)["']/.exec(text)?.[1]
  const block = /MODAL_HOURLY_USD[^=\n]*=\s*\{([^}]*)\}/.exec(text)?.[1]
  if (asOf === undefined || block === undefined) return undefined
  const prices: Record<string, number> = {}
  for (const match of block.matchAll(/["']([^"']+)["']\s*:\s*(\d*\.?\d+)/g)) {
    if (match[1] !== undefined && match[2] !== undefined) prices[match[1]] = Number(match[2])
  }
  return Object.keys(prices).length > 0 ? { asOf, prices } : undefined
}

// forja's worst_case_usd: max_hours times the hourly price, rounded up to a cent.
export function worstCaseUsd(hourlyUsd: number, maxHours: number): number {
  return Math.ceil(Number((hourlyUsd * maxHours * 100).toFixed(6))) / 100
}

// forja's actual_cost_usd.
export function costUsd(hourlyUsd: number, seconds: number): number {
  return Math.round((hourlyUsd * seconds) / 3600 * 10000) / 10000
}

export type Plan = {
  config: string
  settings?: RunSettings
  quote?: Quote
  // Why the price is not known, when it is not.
  problem?: string
}

// What a run will cost, from forja's own quote when one was seen for this
// config, else from Modal's price table. RunPod's price comes from its API.
export function planFor(config: string, raw: Record<string, unknown> | undefined, table: PriceTable, seen?: Quote): Plan {
  if (raw === undefined) return { config, problem: `could not read ${config}, so the cost is not known here` }
  const settings = runSettings(raw)
  const { provider, gpus, maxHours } = settings
  if (maxHours === undefined) return { config, settings, problem: 'max_hours is not a number from 0 to 24, so forja will refuse the config' }
  if (seen !== undefined && seen.provider === provider && seen.maxHours === maxHours) return { config, settings, quote: seen }
  if (provider === 'modal') {
    const gpu = gpus[0] ?? 'L4'
    const hourlyUsd = table.prices[gpu]
    if (hourlyUsd === undefined) return { config, settings, problem: `${gpu} is not a Modal GPU id, so forja will refuse it before creating anything` }
    return {
      config,
      settings,
      quote: {
        provider,
        gpu,
        hourlyUsd,
        maxHours,
        worstUsd: worstCaseUsd(hourlyUsd, maxHours),
        note: `Modal list price as of ${table.asOf}, GPU only`,
        source: 'table',
      },
    }
  }
  if (provider === 'runpod') {
    return {
      config,
      settings,
      problem: 'RunPod gives the price when forja starts (the highest among the listed GPUs with capacity), so it is not known here',
    }
  }
  return { config, settings, problem: `provider ${provider ?? '(missing)'} is not modal or runpod, so forja will refuse the config` }
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`
}

function hoursText(hours: number): string {
  return String(Number(hours.toPrecision(6)))
}

function quoteText(quote: Quote): string {
  return `${quote.provider} ${quote.gpu} at ${formatUsd(quote.hourlyUsd)}/h (${quote.note}); maximum cost ${formatUsd(quote.worstUsd)} for max_hours=${hoursText(quote.maxHours)}`
}

// The reason shown with the permission question. Where nobody can be asked the
// engine refuses the call with this same text, so it reads for both.
export function askText(plans: readonly Plan[], isUnparsed: boolean): string {
  const head = 'forja-cost-guard: `forja run --yes` skips forja\'s own cost question, so the person must approve this call before any GPU is rented.'
  if (isUnparsed || plans.length === 0) {
    return `${head} The command could not be read closely enough to work out the cost. Without that approval the run does not start.`
  }
  const lines = plans.map(plan => {
    if (plan.quote !== undefined) return `Config ${plan.config}: ${quoteText(plan.quote)}.`
    const s = plan.settings
    const known = s === undefined ? '' : ` ${s.provider ?? 'unknown provider'}, GPU ${s.gpus.join(' or ')}${s.maxHours === undefined ? '' : `, max_hours=${hoursText(s.maxHours)}`}.`
    const hint = s?.provider === 'runpod' ? ' To see it first, run the command once without --yes: under the Bash tool forja prints its quote and stops before creating anything.' : ''
    return `Config ${plan.config}:${known} Price not shown: ${plan.problem ?? 'unknown'}.${hint}`
  })
  return `${head} ${lines.join(' ')} Without that approval the run does not start.`
}

// What the model reads when that approval did not come.
export function refusedText(plans: readonly Plan[], isUnparsed: boolean): string {
  return (
    `${askText(plans, isUnparsed)} It was not approved: the person declined, or nobody could be asked in this session. ` +
    'Nothing ran and nothing was created. Do not start it another way; ask the person how to go on. ' +
    'They can also run it in their own terminal, where forja asks its own cost question.'
  )
}

// ---------------------------------------------------------------------------
// forja's output. Each pattern is a line forja's cli.py or orchestrator.py prints.
// ---------------------------------------------------------------------------

const QUOTE_LINE = /^([\w-]+): (.+) at \$(\d+(?:\.\d+)?)\/h \((.*)\); worst case \$(\d+(?:\.\d+)?) for max_hours=([\d.eE+-]+)$/gm

// The last cost line forja printed.
export function parseQuote(output: string): Quote | undefined {
  let quote: Quote | undefined
  for (const m of output.matchAll(QUOTE_LINE)) {
    quote = {
      provider: m[1] ?? '',
      gpu: m[2] ?? '',
      hourlyUsd: Number(m[3]),
      note: m[4] ?? '',
      worstUsd: Number(m[5]),
      maxHours: Number(m[6]),
      source: 'forja',
    }
  }
  return quote
}

// forja asked its cost question and read end of input as no.
export function isPromptAborted(output: string): boolean {
  return /Start the run \(worst case \$[\d.]+\)\? \[y\/N\]:/.test(output) && /^aborted: nothing was created$/m.test(output)
}

export type LeftoverKind = 'unconfirmed' | 'kept' | 'forced' | 'create-unfinished' | 'state-write' | 'warning' | 'exit-3' | 'interrupted'

export type Leftover = { kind: LeftoverKind; provider?: string }

// Lines in which forja itself says remote resources may remain.
const LEFTOVER_LINES: readonly [LeftoverKind, RegExp][] = [
  ['unconfirmed', /^COULD NOT CONFIRM THAT forja-[0-9a-f]{8} WAS DESTROYED .*forja cleanup(?: --provider (\w+))?/m],
  ['kept', /^--keep-on-failure: remote resources kept for debugging.*forja cleanup(?: --provider (\w+))?/m],
  ['forced', /^forced exit: remote resources may still exist\. Run `forja cleanup(?: --provider (\w+))?`/m],
  ['create-unfinished', /^create did not finish; if forja-[0-9a-f]{8} exists remotely, run: forja cleanup(?: --provider (\w+))?/m],
  ['state-write', /^could not update state\.json: .*Run: forja cleanup(?: --provider (\w+))?/m],
  ['warning', /^warning: leftover forja resources on (\w+): /m],
]

export type RunState = {
  provider?: string
  remoteName?: string
  status?: string
  createdAt?: number
  gpuSeconds?: number
  estCostUsd?: number
  destroyConfirmed?: boolean
}

// forja's state.json, written in the run folder before anything remote exists.
export function parseState(text: string): RunState | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object') return undefined
  const s = data as Record<string, unknown>
  const history = Array.isArray(s.history) ? (s.history as unknown[]) : []
  const created = history.find(h => child(h, 'status') === 'created')
  const at = child(created, 'at')
  const createdAt = typeof at === 'string' ? Date.parse(at) : NaN
  return {
    provider: typeof s.provider === 'string' ? s.provider : undefined,
    remoteName: typeof s.remote_name === 'string' ? s.remote_name : undefined,
    status: typeof s.status === 'string' ? s.status : undefined,
    createdAt: Number.isNaN(createdAt) ? undefined : createdAt,
    gpuSeconds: typeof s.gpu_seconds === 'number' ? s.gpu_seconds : undefined,
    estCostUsd: typeof s.est_cost_usd === 'number' ? s.est_cost_usd : undefined,
    destroyConfirmed: typeof s.destroy_confirmed === 'boolean' ? s.destroy_confirmed : undefined,
  }
}

// The run folder forja names on its last line.
export function parseRunFolder(output: string): { runDir: string; status: string; exitCode: number } | undefined {
  const m = /^run folder: (.+) \(status (\w+), exit (\d+)\)$/m.exec(output)
  return m ? { runDir: m[1] ?? '', status: m[2] ?? '', exitCode: Number(m[3]) } : undefined
}

export type RunEnd = {
  exitCode?: number
  // The Bash tool interrupted the command, or a signal ended it.
  isInterrupted: boolean
  output: string
  state?: RunState
  // Whether the mod could look for the run folder at all.
  couldLook: boolean
}

// Whether remote resources may remain after a forja run, from what forja
// printed, its exit code and its state.json.
export function judgeRun(end: RunEnd): Leftover | undefined {
  const provider = end.state?.provider
  for (const [kind, pattern] of LEFTOVER_LINES) {
    const m = pattern.exec(end.output)
    if (m) return { kind, provider: m[1] ?? provider }
  }
  if (end.exitCode === 3) return { kind: 'exit-3', provider }
  if (end.state?.destroyConfirmed === false) return { kind: 'unconfirmed', provider }
  const isCut = end.isInterrupted || (end.exitCode !== undefined && end.exitCode >= 128)
  if (!isCut) return undefined
  if (/^(?:aborted|interrupted): nothing was created$/m.test(end.output)) return undefined
  if (end.state?.destroyConfirmed === true) return undefined
  // A first Ctrl-C: forja cancelled, destroyed and confirmed, then exits 130.
  if (end.exitCode === 130 && /^destroying forja-[0-9a-f]{8} /m.test(end.output)) return undefined
  const hasStarted = end.state !== undefined || /^creating remote resources on /m.test(end.output)
  if (hasStarted || !end.couldLook) return { kind: 'interrupted', provider }
  return undefined
}

// "Exit code 3\n..." on a Bash call that failed.
export function parseExitText(text: string): { exitCode: number; output: string } | undefined {
  const m = /^Exit code (\d+)\r?\n?/.exec(text)
  return m ? { exitCode: Number(m[1]), output: text.slice(m[0].length) } : undefined
}

export type CallOutcome =
  | { kind: 'refused' }
  | { kind: 'background'; outputPath?: string }
  | { kind: 'done'; exitCode?: number; isInterrupted: boolean; output: string }

// What a Bash call came back as: refused before it ran, moved to the
// background, or finished with an exit code and its output.
export function readBashResult(r: { deny?: string; isError?: boolean; text?: string; result?: unknown }): CallOutcome {
  if (r.deny !== undefined) return { kind: 'refused' }
  const text = r.text ?? (typeof r.result === 'string' ? r.result : '')
  if (r.isError === true) {
    const failed = parseExitText(text)
    if (failed) return { kind: 'done', exitCode: failed.exitCode, isInterrupted: false, output: failed.output }
    if (/interrupt/i.test(text)) return { kind: 'done', isInterrupted: true, output: text }
    return { kind: 'refused' }
  }
  const taskId = child(r.result, 'backgroundTaskId')
  if (typeof taskId === 'string' || /Output is being written to: /.test(text)) {
    const remote = child(r.result, 'backgroundOutputPath')
    return { kind: 'background', outputPath: parseOutputPath(text) ?? (typeof remote === 'string' ? remote : undefined) }
  }
  const streams = [child(r.result, 'stdout'), child(r.result, 'stderr')].filter((s): s is string => typeof s === 'string' && s !== '')
  const isInterrupted = child(r.result, 'interrupted') === true
  return { kind: 'done', exitCode: isInterrupted ? undefined : 0, isInterrupted, output: text || streams.join('\n') }
}

// Reminders read back from the store, keeping only well-formed ones.
export function asReminders(value: unknown): Record<string, Reminder> {
  const out: Record<string, Reminder> = {}
  if (value === null || typeof value !== 'object') return out
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const why = child(item, 'why')
    const since = child(item, 'since')
    const provider = child(item, 'provider')
    const config = child(item, 'config')
    if (typeof why !== 'string' || typeof since !== 'number') continue
    out[key] = {
      key,
      why,
      since,
      ...(typeof provider === 'string' ? { provider } : {}),
      ...(typeof config === 'string' ? { config } : {}),
    }
  }
  return out
}

// The background task's output file, as the Bash tool's result names it.
export function parseOutputPath(text: string): string | undefined {
  const path = /Output is being written to: (\S+)/.exec(text)?.[1]
  return path?.replace(/\.$/, '')
}

// The line the Bash tool appends to a background task's output file at exit.
export function parseExitMarker(text: string): { exitCode: number; output: string } | undefined {
  const m = /\n?\[exited with code (\d+)\]\s*$/.exec(text)
  return m ? { exitCode: Number(m[1]), output: text.slice(0, m.index) } : undefined
}

export type CleanupState = 'clean' | 'skipped' | 'left' | 'unlisted'

export type CleanupReport = { providers: Record<string, CleanupState>; isInterrupted: boolean }

// What `forja cleanup` found per provider: `modal: no forja resources`, a
// resource then `deleted`, `kept` or `NOT CONFIRMED`, `skipped`, or a list it
// could not read.
export function parseCleanup(output: string): CleanupReport {
  const providers: Record<string, CleanupState> = {}
  // Resources listed and not yet shown deleted, per provider.
  const open: Record<string, number> = {}
  const failed = new Set<string>()
  let current: string | undefined
  for (const line of output.split(/\r?\n/)) {
    let m: RegExpExecArray | null
    if ((m = /^(\w+): skipped \(/.exec(line))) {
      providers[m[1] ?? ''] = 'skipped'
    } else if ((m = /^(\w+): no forja resources$/.exec(line))) {
      providers[m[1] ?? ''] = 'clean'
    } else if ((m = /^(\w+): could not list forja resources/.exec(line))) {
      providers[m[1] ?? ''] = 'unlisted'
    } else if ((m = /^(\w+): forja-[0-9a-f]{8} \(since /.exec(line))) {
      current = m[1] ?? ''
      open[current] = (open[current] ?? 0) + 1
    } else if (current !== undefined && /^\s+deleted\b/.test(line)) {
      open[current] = (open[current] ?? 1) - 1
    } else if (current !== undefined && /^\s+(kept|NOT CONFIRMED)\b/.test(line)) {
      failed.add(current)
    }
  }
  for (const [name, count] of Object.entries(open)) {
    providers[name] = failed.has(name) || count > 0 ? 'left' : 'clean'
  }
  const isInterrupted = /^interrupted: some resources may not have been deleted/m.test(output)
  return { providers, isInterrupted }
}

// Whether a cleanup run shows a reminder's provider free of forja resources.
export function cleanupClears(report: CleanupReport, exitCode: number, key: string): boolean {
  if (exitCode !== 0 || report.isInterrupted) return false
  const states = Object.values(report.providers)
  if (key === 'unknown') return states.length > 0 && states.every(state => state === 'clean')
  return report.providers[key] === 'clean'
}

// ---------------------------------------------------------------------------
// Text for the band, the toasts and the model.
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}h ${pad(m)}m`
  if (m > 0) return `${m}m ${pad(s)}s`
  return `${s}s`
}

export function runLine(run: TrackedRun, now: number): string {
  const elapsed = run.startedAt === undefined ? 0 : now - run.startedAt
  const what = [run.provider, run.gpu].filter(Boolean).join(' ')
  const parts = [`forja run ${basename(run.config)}${what ? `: ${what}` : ''}`, `${formatDuration(elapsed)} elapsed`]
  if (run.hourlyUsd === undefined) {
    parts.push('price not known yet')
    if (run.maxHours !== undefined) parts.push(`max_hours=${hoursText(run.maxHours)}`)
  } else {
    parts.push(`${formatUsd(run.hourlyUsd)}/h`, `${formatUsd(costUsd(run.hourlyUsd, elapsed / 1000))} so far`)
    if (run.worstUsd !== undefined) parts.push(`max ${formatUsd(run.worstUsd)}`)
  }
  if (run.status !== undefined && run.status !== 'running') parts.push(run.status)
  return parts.join(' · ')
}

const WHY: Record<LeftoverKind, string> = {
  unconfirmed: 'forja could not confirm the delete',
  kept: 'kept by --keep-on-failure',
  forced: 'forja was forced to exit',
  'create-unfinished': 'creating them did not finish',
  'state-write': 'forja could not record the delete',
  warning: 'forja found leftovers from an earlier run',
  'exit-3': 'forja exited with code 3',
  interrupted: 'the run was interrupted',
}

export function leftoverWhy(leftover: Leftover): string {
  return WHY[leftover.kind]
}

export function cleanupCommand(provider?: string): string {
  return provider ? `forja cleanup --provider ${provider}` : 'forja cleanup'
}

export function reminderLine(reminder: Reminder): string {
  const where = reminder.provider ? ` on ${reminder.provider}` : ''
  return `Remote forja resources may still exist${where} (${reminder.why}). Run \`${cleanupCommand(reminder.provider)}\`.`
}

export function leftoverNote(leftover: Leftover, intro: string): string {
  const where = leftover.provider ? ` on ${leftover.provider}` : ''
  const command = `${cleanupCommand(leftover.provider)} --yes`
  const what = `forja-cost-guard: ${intro}remote resources may still exist${where} (${leftoverWhy(leftover)}). They keep billing until deleted.`
  const how =
    'Without --yes, forja cleanup asks before each delete, gets no input under the Bash tool and stops with exit 130. ' +
    "It needs the provider's credentials in this environment; a line ending in `skipped (...)` means it did not check that provider. " +
    'If it cannot run here, ask the person to run `forja cleanup` in a terminal that has the credentials.'
  if (leftover.kind === 'kept') {
    return `${what} The run kept them on purpose for debugging: tell the person, and when they are done run \`${command}\`. ${how}`
  }
  return `${what} Tell the person and run \`${command}\`. ${how}`
}

export function abortedNote(quote: Quote | undefined): string {
  const cost = quote === undefined ? '' : ` Its quote: ${quoteText(quote)}.`
  return (
    'forja-cost-guard: forja asked its cost question, but the Bash tool gives commands no input, so forja read that as no and stopped with exit 2. Nothing was created.' +
    `${cost} To start the run, run the same command with --yes, with run_in_background set to true since a run outlasts the Bash timeout. ` +
    'forja-cost-guard asks the person to approve the cost before it starts, and shows the running cost above the prompt.'
  )
}

export const CLEANUP_PROMPT_NOTE =
  'forja-cost-guard: forja cleanup asks before each delete; the Bash tool gives it no input, so it stopped with exit 130 and deleted nothing more. ' +
  'Run `forja cleanup --yes` (add --provider modal or --provider runpod to limit it) to delete the leftovers it listed.'

export function skippedNote(provider: string): string {
  return (
    `forja-cost-guard: ${provider} was skipped (no credentials in this environment), so its leftovers were not checked and the reminder stays. ` +
    `Ask the person to run \`forja cleanup --provider ${provider}\` in a terminal that has the ${provider} credentials.`
  )
}

// Run folders forja names `<date>_<project>_r<N>`.
export function isRunFolder(name: string, project: string): boolean {
  return new RegExp(`^\\d{4}-\\d{2}-\\d{2}_${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_r\\d+$`).test(name)
}
