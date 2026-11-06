import type { McpCall, PiiCount } from '../types'

// ---- MCP tool names ----

export type McpName = { server: string; tool: string }

// `mcp__<server>__<tool>`: the server runs up to the next `__`, the tool is
// the rest. Anything else is not an MCP tool.
export function parseMcpTool(name: string): McpName | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  if (cut <= 0 || cut + 2 >= rest.length) return undefined
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}

// The desktop app's own servers (task list, chapters, panes) are part of the
// harness, not MCP servers anyone added: they would bury the lab's calls.
export const isHostServer = (server: string) => server.startsWith('ccd_')

// ---- mcp-lab ----

// Files only mcp-lab has, for a worktree or a clone under another name.
export const LAB_MARKERS = ['packages/opsdesk-server/pyproject.toml', 'packages/mcp-gateway/registry.yaml'] as const

export const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

export const isLabName = (root: string) => basename(root) === 'mcp-lab'

// ---- text helpers ----

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

// Keys the engine puts beside a tool's own arguments.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

// `service=search status=open`: each argument on one line, long values cut.
export function shortInput(input: Record<string, unknown>, max = 80): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (RESERVED.has(key) || value === undefined) continue
    parts.push(`${key}=${clip(oneLine(stringify(value)), 40)}`)
  }
  return clip(parts.join(' '), max)
}

// The first non-empty lines of a result, each cut to a sane length. JSON is
// put on one line first, so the head shows data rather than `{`, and the
// engine's `<tool_use_error>` wrapper is dropped.
export function headLines(text: string, count: number, max = 300): string[] {
  return compactJson(text.replace(/<\/?tool_use_error>/g, ''))
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(0, count)
    .map(line => clip(line, max))
}

function compactJson(text: string): string {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed) || trimmed.length > SCAN_LIMIT) return text
  try {
    return JSON.stringify(JSON.parse(trimmed))
  } catch {
    return text
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
}

// ---- results ----

// What a tool.call resolves to, as far as this mod reads it.
export type Ran = { deny?: string; isError?: boolean; text?: string; result?: unknown }

export type Outcome = { status: 'ok' | 'error'; text: string; code?: number }

export function resultText(ran: Ran): string {
  if (typeof ran.text === 'string' && ran.text !== '') return ran.text
  return stringify(ran.result)
}

// A refused call counts as an error: the model read the refusal.
export function outcomeOf(ran: Ran): Outcome {
  if (typeof ran.deny === 'string') return withCode('error', ran.deny)
  const text = resultText(ran)
  return ran.isError === true ? withCode('error', text) : { status: 'ok', text }
}

function withCode(status: 'error', text: string): Outcome {
  const code = errorCode(text)
  return code === undefined ? { status, text } : { status, text, code }
}

// `MCP error -32021: ...` is how the TypeScript SDK words a JSON-RPC error;
// `"code": -32021` is the error object itself; a bare -32xxx in the reserved
// range (-32768 to -32000) is the last resort.
export function errorCode(text: string): number | undefined {
  const sdk = /\bMCP error (-?\d{1,6})\b/i.exec(text)?.[1]
  if (sdk !== undefined) return Number(sdk)
  const field = /"code"\s*:\s*(-\d{1,6})\b/.exec(text)?.[1]
  if (field !== undefined) return Number(field)
  for (const match of text.matchAll(/(?<![\w.-])(-32\d{3})(?!\d)/g)) {
    const code = Number(match[1])
    if (code >= -32768 && code <= -32000) return code
  }
  return undefined
}

// ---- personal data ----

// Local part: a whole run of RFC 5322 atext characters and dots, entered only
// at its start (the look-behind), so matching stays linear. Domain: dotted
// labels, then a top-level domain of letters only, so `lodash@4.17.21` and
// `[REDACTED:email]` do not count. The gateway's own rule (gateway/redaction.py).
const ATEXT = String.raw`\p{L}\p{N}_!#$%&'*+/=?^\x60{|}~.\-`
const EMAIL = new RegExp(String.raw`(?<![${ATEXT}])[${ATEXT}]+@(?:[\p{L}\p{N}_\-]{1,63}\.)+\p{L}{2,63}`, 'gu')

// Phone numbers, in three shapes. Each group of digits sits behind a
// separator, so the patterns never try one digit run many ways.
// 1. International: `+` and a country code (`+1 415 555 0132`,
//    `+44 20 7946 0958`, `+1 (415) 555-0132`, `+14155550132`).
const INTERNATIONAL = new RegExp(
  String.raw`(?<![\p{L}\p{N}_+])\+(?:\d{9,15}|\d{1,4}(?:[ .\-]?\(\d{1,5}\)|[ .\-]\d{1,10}){1,7})(?![\p{L}\p{N}])`,
  'gu',
)
// 2. North American: `(415) 555-0132`, `415-555-0132`, `415.555.0132`,
//    `1-800-555-0199`. Area code and exchange start with 2-9 and the
//    separators match, so `100-200-3000`, dates and IPs stay out. Bare spaces
//    (`512 256 1024`) are too common in numbers to count.
const NORTH_AMERICAN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.+\-/:#@])(?:1[ .\-])?(?:\([2-9]\d{2}\) ?[2-9]\d{2}[ .\-]\d{4}|[2-9]\d{2}([.\-])[2-9]\d{2}\1\d{4})(?![\p{L}\p{N}_]|[.\-/:]\d)`,
  'gu',
)
// 3. Labelled: any 7 to 15 digits right after a word that says phone
//    (`phone: 612 345 678`, `"phoneNumber": "0612345678"`, `tel:+33...`).
const LABELLED = new RegExp(
  String.raw`(?<!\p{L})(?:telephone|phone|tel|mobile|cell[ _\-]?phone|fax|whatsapp|sms)(?:[ _\-]?(?:number|num|no))?(?!\p{L})\.?["']?\s*[:=]?\s*["']?\s*(?:tel:)?` +
    String.raw`(\+?(?:\d{7,15}(?!\d)|\(?\d{1,5}\)?(?:[ .\-]?\(\d{1,5}\)|[ .\-]\d{1,10}){1,7}))`,
  'giu',
)

const DATE = /^\+?\d{4}[-./]\d{1,2}[-./]\d{1,2}$/
const digitsOf = (text: string) => text.replace(/\D/g, '')

function isInternational(match: string): boolean {
  const digits = digitsOf(match)
  if (/^\+\d+$/.test(match)) return digits.length >= 10 && digits.length <= 15
  if (digits.length < 8 || digits.length > 15 || DATE.test(match)) return false
  // `+1 2 3 4 5 6 7 8` is no number anyone dials.
  return match.split(/\D+/).filter(group => group.length >= 2).length >= 2
}

function isLabelled(match: string): boolean {
  const digits = digitsOf(match)
  return digits.length >= 7 && digits.length <= 15 && !DATE.test(match)
}

type Span = { start: number; end: number; value: string }

function spans(text: string, pattern: RegExp, group: number, accept: (match: string) => boolean): Span[] {
  const found: Span[] = []
  for (const match of text.matchAll(pattern)) {
    const value = match[group]
    if (value === undefined || !accept(value)) continue
    const start = (match.index ?? 0) + match[0].length - value.length
    found.push({ start, end: start + value.length, value })
  }
  return found
}

// Matches that overlap an earlier, longer one are the same number.
function distinct(found: Span[]): Span[] {
  const sorted = [...found].sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Span[] = []
  for (const span of sorted) {
    const last = kept[kept.length - 1]
    if (last !== undefined && span.start < last.end) continue
    kept.push(span)
  }
  return kept
}

// What a scan looks at: enough for any result, and linear in it.
const SCAN_LIMIT = 200_000

export function findEmails(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.slice(0, SCAN_LIMIT).matchAll(EMAIL)) seen.add(match[0].toLowerCase())
  return [...seen]
}

export function findPhones(text: string): string[] {
  const body = text.slice(0, SCAN_LIMIT)
  const found = distinct([
    ...spans(body, LABELLED, 1, isLabelled),
    ...spans(body, INTERNATIONAL, 0, isInternational),
    ...spans(body, NORTH_AMERICAN, 0, () => true),
  ])
  const seen = new Set<string>()
  for (const span of found) seen.add((span.value.trim().startsWith('+') ? '+' : '') + digitsOf(span.value))
  return [...seen]
}

export function piiCount(text: string): PiiCount | undefined {
  const emails = findEmails(text).length
  const phones = findPhones(text).length
  return emails + phones === 0 ? undefined : { emails, phones }
}

// Everything the call handed back: the text the model read, a refusal, and
// the tool's record when it differs from the text (structured content).
export function piiText(ran: Ran): string {
  const parts = [ran.text, ran.deny, stringify(ran.result)].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  )
  return [...new Set(parts)].join('\n')
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function describePii(pii: PiiCount): string {
  const parts: string[] = []
  if (pii.emails > 0) parts.push(plural(pii.emails, 'email address', 'email addresses'))
  if (pii.phones > 0) parts.push(plural(pii.phones, 'phone number', 'phone numbers'))
  return parts.join(' and ')
}

export function piiToast(call: Pick<McpCall, 'server' | 'tool'>, pii: PiiCount): string {
  const them = pii.emails + pii.phones === 1 ? 'it' : 'them'
  return `MCP inspector: ${call.server}/${call.tool} returned ${describePii(pii)}. The gateway's redaction should have removed ${them}.`
}

// ---- the pane ----

export const rowsOf = (call: McpCall) => 1 + call.head.length + (call.pii ? 1 : 0)

// The newest calls that fit in `rows`, oldest first; the newest always shows.
export function fitCalls(list: readonly McpCall[], rows: number): { shown: McpCall[]; hidden: number } {
  let first = list.length
  let used = 0
  while (first > 0) {
    const call = list[first - 1]
    if (call === undefined) break
    const need = rowsOf(call)
    if (used + need > rows && first < list.length) break
    used += need
    first -= 1
  }
  return { shown: list.slice(first), hidden: first }
}

export function statusWord(call: McpCall): string {
  return call.status === 'running' ? 'runs ' : call.status === 'ok' ? 'ok   ' : 'error'
}

export function callLine(call: McpCall): string {
  const parts = [call.durationMs === undefined ? '...' : formatDuration(call.durationMs)]
  if (call.code !== undefined) parts.push(String(call.code))
  parts.push(`${call.server}/${call.tool}`)
  if (call.input !== '') parts.push(call.input)
  if (call.agentId !== undefined) parts.push('(subagent)')
  return parts.join('  ')
}

export function summaryLine(list: readonly McpCall[], hidden: number): string {
  const errors = list.filter(call => call.status === 'error').length
  const flagged = list.filter(call => call.pii !== undefined).length
  const parts = [plural(list.length, 'MCP call', 'MCP calls')]
  if (errors > 0) parts.push(plural(errors, 'error', 'errors'))
  if (flagged > 0) parts.push(`${flagged} with personal data`)
  if (hidden > 0) parts.push(`${hidden} older above`)
  return parts.join(', ')
}

// ---- the tool-selection log (M3) ----

export type LogEntry = { id: string; prompt: string; tools: string[]; at: string }

// With at most 1000 entries kept, the log stays near 2 MB, under the
// store's 4 MiB.
export const MAX_PROMPT = 2000

export function clipPrompt(text: string): string {
  return text.length > MAX_PROMPT ? `${text.slice(0, MAX_PROMPT)} [truncated]` : text
}

export function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.prompt === 'string' &&
    typeof entry.at === 'string' &&
    Array.isArray(entry.tools) &&
    entry.tools.every(tool => typeof tool === 'string')
  )
}

export function readLog(value: unknown): LogEntry[] {
  return Array.isArray(value) ? value.filter(isLogEntry) : []
}

// One JSON object per line: `{"prompt", "tools", "at"}`.
export function toJsonl(log: readonly LogEntry[]): string {
  return log.map(entry => `${JSON.stringify({ prompt: entry.prompt, tools: entry.tools, at: entry.at })}\n`).join('')
}

// ---- the command ----

export type InspectorCommand =
  | { kind: 'open' }
  | { kind: 'clear' }
  | { kind: 'export'; path: string }
  | { kind: 'usage'; reason?: string }

export const USAGE =
  'Usage: /mcp-inspector opens the pane; /mcp-inspector export <path> writes the tool-selection log as JSONL; /mcp-inspector clear empties the log and the pane.'

const unquote = (text: string) => text.replace(/^(["'])(.*)\1$/s, '$2')

export function parseCommand(args: string): InspectorCommand {
  const text = args.trim()
  if (text === '' || text === 'open') return { kind: 'open' }
  const word = text.split(/\s+/, 1)[0] ?? ''
  const rest = text.slice(word.length).trim()
  if (word === 'clear' && rest === '') return { kind: 'clear' }
  if (word === 'export') {
    const path = unquote(rest).trim()
    return path === '' ? { kind: 'usage', reason: 'export needs a path.' } : { kind: 'export', path }
  }
  return { kind: 'usage', reason: `unknown argument "${clip(text, 40)}".` }
}

// An absolute path for the export: `~/` under home, a relative path under the
// session folder. Undefined when `~` cannot be placed.
export function resolvePath(path: string, cwd: string, home: string | undefined): string | undefined {
  if (path === '~' || path.startsWith('~/')) {
    if (home === undefined || home === '' || path === '~') return undefined
    return `${home.replace(/\/+$/, '')}${path.slice(1)}`
  }
  if (path.startsWith('/')) return path
  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}
