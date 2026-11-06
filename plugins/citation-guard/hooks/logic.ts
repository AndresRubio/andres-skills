import type { Change, Entry, Ledger } from '../types'

// ---------------------------------------------------------------------------
// Which files matter
// ---------------------------------------------------------------------------

// Cheap test on a full path, run before anything touches git. Looser than
// `kindOf`: it only has to let every candidate through.
const CANDIDATE = /\/(?:src\/data\/(?:armies\/)?[^/]+\.ts|CITATIONS\.md)$/

export function mayMatter(path: string): boolean {
  return CANDIDATE.test(path)
}

// `rel` is the path from the repo root. Army data holds the game values: the
// army files, the magic item catalogue, shared options, the movement table
// and the spell lists. Tests, the assembly point and the integrity checks are
// code, not data.
export function kindOf(rel: string): 'data' | 'citations' | undefined {
  if (rel === 'CITATIONS.md') return 'citations'
  if (/^src\/data\/(?:magicItems|unitOptions|movement|lores)\.ts$/.test(rel)) return 'data'
  const army = /^src\/data\/armies\/([^/]+)\.ts$/.exec(rel)?.[1]
  if (army !== undefined && !army.endsWith('.test') && army !== 'index' && army !== 'integrity') return 'data'
  return undefined
}

// ---------------------------------------------------------------------------
// Reading numbers out of a TypeScript data file
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'id'; value: string }
  | { kind: 'punct'; value: string }

const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/y
const IDENT = /[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/y

const isDigit = (c: string) => c >= '0' && c <= '9'

// A quoted run that starts at `from`. A plain quote stops at the end of the
// line, so one stray quote cannot swallow the rest of the file.
function endOfString(src: string, from: number): number {
  const quote = src.charAt(from)
  let i = from + 1
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === '\\') i += 2
    else if (c === quote) return i + 1
    else if (c === '\n' && quote !== '`') return i
    else i += 1
  }
  return src.length
}

// Comments and whitespace are dropped. Text stays as 'str' tokens whose
// content is never read as a number.
export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src.charAt(i)
    const next = src.charAt(i + 1)
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i += 1
    } else if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      i = end === -1 ? src.length : end + 1
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
    } else if (c === '"' || c === "'" || c === '`') {
      const end = endOfString(src, i)
      const isClosed = end - 1 > i && src.charAt(end - 1) === c
      out.push({ kind: 'str', value: src.slice(i + 1, isClosed ? end - 1 : end) })
      i = end
    } else if (isDigit(c) || (c === '.' && isDigit(next)) || (c === '-' && isUnaryMinus(out) && (isDigit(next) || (next === '.' && isDigit(src.charAt(i + 2)))))) {
      const sign = c === '-' ? -1 : 1
      NUMBER.lastIndex = c === '-' ? i + 1 : i
      const hit = NUMBER.exec(src)
      if (hit === null) {
        out.push({ kind: 'punct', value: c })
        i += 1
      } else {
        out.push({ kind: 'num', value: sign * Number(hit[0].replace(/_/g, '')) })
        i = NUMBER.lastIndex
      }
    } else {
      IDENT.lastIndex = i
      const hit = IDENT.exec(src)
      if (hit === null) {
        out.push({ kind: 'punct', value: c })
        i += 1
      } else {
        out.push({ kind: 'id', value: hit[0] })
        i = IDENT.lastIndex
      }
    }
  }
  return out
}

// A minus that starts a value (`: -1`, `(-2`) and not a subtraction.
function isUnaryMinus(tokens: readonly Token[]): boolean {
  const prev = tokens[tokens.length - 1]
  if (prev === undefined) return true
  if (prev.kind === 'num' || prev.kind === 'str' || prev.kind === 'id') return false
  return prev.value !== ')' && prev.value !== ']'
}

type Frame = {
  open: '' | '{' | '[' | '('
  // The key the frame hangs from (`statLine` for `statLine: { ... }`).
  label: string
  parent: Frame | undefined
  lastKey: string | undefined
  // What names an entry: `id`, else `unitId`, else `name`.
  id?: string
  unitId?: string
  name?: string
}

type Raw = { frame: Frame; decl: string; keyName: string; value: number }

export type Fact = {
  key: string
  // Entry chain up to and including the last entry with an id. Facts that
  // share it belong to one entry.
  owner: string
  where: string
  field: string
  // The key alone (`WS`), without the path to it.
  leaf: string
  value: number
}

const CLOSES = { '}': '{', ']': '[', ')': '(' } as const
const DECLARES = new Set(['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum'])
const NAMING_KEYS = new Set(['id', 'unitId', 'name'])

const identOf = (f: Frame) => f.id ?? f.unitId ?? f.name

function joinField(parts: readonly string[]): string {
  let out = ''
  for (const part of parts) {
    if (part === '') continue
    out = out === '' ? part : part.startsWith('[') ? out + part : `${out}.${part}`
  }
  return out
}

// Every number that sits in code: `key: 12`, the values of a stat line, the
// entries of a table. Text, comments and the keys themselves are not numbers
// here. Each number gets an address built from the declaration, the entries
// around it (by id) and its key, so the same number has the same address
// wherever it moves in the file.
export function facts(src: string): Fact[] {
  const tokens = tokenize(src)
  const root: Frame = { open: '', label: '', parent: undefined, lastKey: undefined }
  let frame = root
  let decl = ''
  const raws: Raw[] = []

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === undefined) break
    const after = tokens[i + 1]
    const isKey = after?.kind === 'punct' && after.value === ':'

    if (tok.kind === 'punct') {
      if (tok.value === '{' || tok.value === '[' || tok.value === '(') {
        const isCall = tok.value === '('
        frame = {
          open: tok.value,
          label: isCall ? '' : (frame.lastKey ?? ''),
          parent: frame,
          lastKey: isCall ? frame.lastKey : undefined,
        }
      } else if (tok.value === '}' || tok.value === ']' || tok.value === ')') {
        const open = CLOSES[tok.value]
        for (let f: Frame | undefined = frame; f !== undefined && f !== root; f = f.parent) {
          if (f.open === open) {
            frame = f.parent ?? root
            break
          }
        }
      }
    } else if (tok.kind === 'id' || tok.kind === 'str') {
      if (frame === root && tok.kind === 'id') {
        if (tok.value === 'export') decl = ''
        else if (DECLARES.has(tok.value) && after?.kind === 'id') decl = after.value
      }
      // At the top of a file `name:` is a type annotation, except in a fragment
      // that holds no declaration, where it is a key.
      if (isKey && (frame !== root || decl === '')) {
        frame.lastKey = tok.value
        const value = tokens[i + 2]
        if (frame.open === '{' && NAMING_KEYS.has(tok.value) && value?.kind === 'str') {
          if (tok.value === 'id') frame.id ??= value.value
          else if (tok.value === 'unitId') frame.unitId ??= value.value
          else frame.name ??= value.value
        }
      }
    } else if (isKey) {
      // A number used as a key (`3: 8` in a table).
      frame.lastKey = String(tok.value)
    } else {
      raws.push({ frame, decl, keyName: frame.lastKey ?? '', value: tok.value })
    }
  }

  const seen = new Map<string, number>()
  const all = raws.map(raw => {
    const chain: Frame[] = []
    for (let f: Frame | undefined = raw.frame; f !== undefined && f !== root; f = f.parent) {
      if (f.open !== '(') chain.unshift(f)
    }
    const names = chain.map(f => ({ text: identOf(f) ?? f.label, isId: identOf(f) !== undefined }))
    const lastId = names.map(n => n.isId).lastIndexOf(true)

    const base = [raw.decl, ...names.map(n => n.text), raw.keyName].join('/')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)

    const ids = names.filter(x => x.isId).map(x => x.text)
    const rest = [...names.slice(lastId + 1).map(x => x.text), raw.keyName]
    const field = joinField(rest) || '(value)'
    return {
      key: `${base}#${n}`,
      owner: [raw.decl, ...names.slice(0, lastId + 1).map(x => x.text)].join('/'),
      where: ids.length > 0 ? ids.join(' > ') : raw.decl || '(top level)',
      field: n > 0 ? `${field}[${n}]` : field,
      leaf: raw.keyName,
      value: raw.value,
    }
  })

  // The same id under two owners (a shield option priced twice, an item sold
  // to three armies) needs more than the id to tell them apart.
  const owners = new Map<string, Set<string>>()
  for (const f of all) owners.set(f.where, (owners.get(f.where) ?? new Set<string>()).add(f.owner))
  return all.map(f =>
    (owners.get(f.where)?.size ?? 0) > 1 ? { ...f, where: f.owner.split('/').filter(Boolean).join(' > ') } : f,
  )
}

// ---------------------------------------------------------------------------
// Comparing two versions
// ---------------------------------------------------------------------------

// What a group of numbers says, whatever it is called and wherever it sits.
const signature = (group: readonly Fact[]) =>
  group
    .map(f => `${f.leaf}=${f.value}`)
    .sort()
    .join('|')

function byOwner(list: readonly Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>()
  for (const f of list) groups.set(f.owner, [...(groups.get(f.owner) ?? []), f])
  return groups
}

// An entry that was renamed, moved, or whose numbers were lifted into a shared
// constant shows up as gone in one place and new in another, with the same
// numbers. That is no value change: a group with a twin on the other side is
// dropped, and what has none stays.
function withoutMoves(gone: readonly Fact[], fresh: readonly Fact[]): { gone: Fact[]; fresh: Fact[] } {
  const goneGroups = byOwner(gone)
  const freshGroups = byOwner(fresh)
  const goneSigs = new Set([...goneGroups.values()].map(signature))
  const freshSigs = new Set([...freshGroups.values()].map(signature))
  const twinless = (groups: Map<string, Fact[]>, others: Set<string>) =>
    [...groups.values()].filter(group => !others.has(signature(group))).flat()
  return { gone: twinless(goneGroups, freshSigs), fresh: twinless(freshGroups, goneSigs) }
}

// The game numbers whose value differs between two texts, new ones and
// removed ones included. Wording, comments, quotes, spacing, the order of
// keys or entries, and `10.0` against `10` do not count.
export function diffNumbers(before: string, after: string): Change[] {
  if (before === after) return []
  const old = new Map(facts(before).map(f => [f.key, f] as const))
  const now = new Map(facts(after).map(f => [f.key, f] as const))

  const changed: Change[] = []
  const fresh: Fact[] = []
  const gone: Fact[] = []
  for (const [key, f] of now) {
    const was = old.get(key)
    if (was === undefined) fresh.push(f)
    else if (was.value !== f.value) changed.push({ key, where: f.where, field: f.field, from: was.value, to: f.value })
  }
  for (const [key, f] of old) if (!now.has(key)) gone.push(f)

  const moved = withoutMoves(gone, fresh)
  return [
    ...changed,
    ...moved.fresh.map(f => ({ key: f.key, where: f.where, field: f.field, to: f.value })),
    ...moved.gone.map(f => ({ key: f.key, where: f.where, field: f.field, from: f.value })),
  ]
}

// The text an Edit leaves behind, or undefined when old_string is not in it.
export function applyEdit(text: string, oldString: string, newString: string, replaceAll: boolean): string | undefined {
  if (oldString === '') return text === '' ? newString : undefined
  const at = text.indexOf(oldString)
  if (at === -1) return undefined
  if (replaceAll) return text.split(oldString).join(newString)
  return text.slice(0, at) + newString + text.slice(at + oldString.length)
}

// ---------------------------------------------------------------------------
// What the model and the user read
// ---------------------------------------------------------------------------

export const isChanged = (c: Change) => c.from !== undefined && c.to !== undefined

export function changeLine(c: Change): string {
  return `${c.where} ${c.field}: ${c.from ?? '(new)'} -> ${c.to ?? '(removed)'}`
}

function limited(lines: readonly string[], limit: number): string[] {
  return lines.length <= limit ? [...lines] : [...lines.slice(0, limit), `and ${lines.length - limit} more`]
}

export function describeChanges(changes: readonly Change[], limit: number): string[] {
  return limited(changes.map(changeLine), limit)
}

export function contextNote(file: string, changes: readonly Change[], isCitedThisTurn: boolean): string {
  const next = isCitedThisTurn
    ? 'CITATIONS.md was already edited this turn. Check that its entry names these values and the book page.'
    : "CITATIONS.md is this repo's provenance index: every corrected game value needs an entry there with its book page. Add that entry in this same turn, before you finish. If you do not have the page, ask the user instead of guessing."
  return [
    `citation-guard: that edit changed game values in ${file}:`,
    ...describeChanges(changes, 15).map(line => `- ${line}`),
    next,
  ].join('\n')
}

export const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

const short = (file: string) => file.replace(/^src\/data\//, '')

export type Report = { root: string; files: string[] }

export function toastText(report: readonly Report[]): string {
  const names = report.flatMap(r =>
    r.files.map(f => (report.length > 1 ? `${basename(r.root)}:${short(f)}` : short(f))),
  )
  const shown = names.slice(0, 4)
  const list =
    names.length > shown.length
      ? `${shown.join(', ')} and ${names.length - shown.length} more`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
        : (shown[0] ?? '')
  return `Citation guard: values changed in ${list}, but CITATIONS.md was not edited this turn. /citation-guard lists them.`
}

export function listText(ledger: Ledger): string {
  const pending = ledger.entries.filter(e => !e.isCited)
  if (pending.length === 0) return 'Citation guard: no uncited value changes this session.'

  const roots = [...new Set(pending.map(e => e.root))]
  const files = new Set(pending.map(e => `${e.root}\n${e.file}`)).size
  const out = [
    `Citation guard: ${pending.length} uncited value ${pending.length === 1 ? 'change' : 'changes'} in ${files} ${files === 1 ? 'file' : 'files'} this session (old -> new).`,
  ]
  for (const root of roots) {
    for (const file of [...new Set(pending.filter(e => e.root === root).map(e => e.file))]) {
      out.push('', roots.length > 1 ? `${basename(root)}: ${file}` : file)
      const lines = pending.filter(e => e.root === root && e.file === file).map(changeLine)
      for (const line of limited(lines, 30)) out.push(`  ${line}`)
    }
  }
  out.push('', 'CITATIONS.md has not been edited since these changes. Each corrected value needs an entry there with its book page.')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// The ledger: what the session changed, and what CITATIONS.md has covered
// ---------------------------------------------------------------------------

export const EMPTY_LEDGER: Ledger = { turn: 0, entries: [], citedRoots: [] }

const MAX_ENTRIES = 400

function trimmed(entries: Entry[]): Entry[] {
  const out = [...entries]
  while (out.length > MAX_ENTRIES) {
    const cited = out.findIndex(e => e.isCited)
    out.splice(cited === -1 ? 0 : cited, 1)
  }
  return out
}

// Adds what one edit changed. A number that was already changed and not yet
// cited keeps its first old value, so two edits make one change, and a number
// put back as it was is no change at all. `fresh` is what this edit changed
// and still stands.
export function record(
  ledger: Ledger,
  root: string,
  file: string,
  changes: readonly Change[],
): { ledger: Ledger; fresh: Change[] } {
  const entries = [...ledger.entries]
  const isCited = ledger.citedRoots.includes(root)
  const fresh: Change[] = []
  for (const c of changes) {
    const at = entries.findIndex(e => e.root === root && e.file === file && e.key === c.key && !e.isCited)
    const known = entries[at]
    if (known === undefined) {
      entries.push({ ...c, root, file, turn: ledger.turn, isCited })
      fresh.push(c)
    } else if (known.from === c.to) {
      entries.splice(at, 1)
    } else {
      entries[at] = { ...known, where: c.where, field: c.field, to: c.to, turn: ledger.turn }
      fresh.push(c)
    }
  }
  return { ledger: { ...ledger, entries: trimmed(entries) }, fresh }
}

// CITATIONS.md of this repo was edited: what is open there is covered, and so
// is whatever else this turn changes.
export function cite(ledger: Ledger, root: string): Ledger {
  return {
    ...ledger,
    entries: ledger.entries.map(e => (e.root === root && !e.isCited ? { ...e, isCited: true } : e)),
    citedRoots: ledger.citedRoots.includes(root) ? ledger.citedRoots : [...ledger.citedRoots, root],
  }
}

// Does the turn that ends hold anything to settle?
export const hasTurnWork = (ledger: Ledger) =>
  ledger.citedRoots.length > 0 || ledger.entries.some(e => e.turn === ledger.turn && !e.isCited)

// Closes the turn: the repos whose values changed in it with no CITATIONS.md
// edit, with the files, and the ledger for the next turn.
export function endTurn(ledger: Ledger): { ledger: Ledger; report: Report[] } {
  const open = ledger.entries.filter(e => e.turn === ledger.turn && !e.isCited)
  const report = [...new Set(open.map(e => e.root))].map(root => ({
    root,
    files: [...new Set(open.filter(e => e.root === root).map(e => e.file))],
  }))
  return { ledger: { turn: ledger.turn + 1, entries: ledger.entries, citedRoots: [] }, report }
}
