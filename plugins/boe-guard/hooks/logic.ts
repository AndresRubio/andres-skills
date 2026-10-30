// Pure logic for boe-guard: no engine calls, so each rule is unit-tested.
//
// Two jobs. Read paths: which files of the boe-agent repo may not be read
// whole (PROGRESS.md, docs/superpowers/plans/). Bash commands: which ones
// dump such a file, and which ones load BDNS or BOE data. Commands are
// parsed into simple commands first (quotes, `cd`, `VAR=x`, `bash -c`,
// `$(...)`), so a path or a module name quoted inside an `echo`, a commit
// message or a heredoc is not mistaken for a real one.

// A section of PROGRESS.md is at most about 700 lines, so a `limit` past
// this is a whole read in disguise.
export const MAX_LINES = 1000

export type Context = { cwd: string; home: string }

// ---------------------------------------------------------------- paths

export function normalize(path: string): string {
  const isAbsolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!isAbsolute) out.push('..')
    } else out.push(part)
  }
  return (isAbsolute ? '/' : '') + out.join('/') || (isAbsolute ? '/' : '.')
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').replace(/^.*\//, '')
}

export function dirname(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

// `~` and `$HOME` in a path word, then the path made absolute and clean.
export function absolutePath(path: string, ctx: Context): string {
  let p = path
  if (p === '~' || p.startsWith('~/')) p = ctx.home + p.slice(1)
  return normalize(p.startsWith('/') ? p : `${ctx.cwd}/${p}`)
}

export function relativeTo(root: string, path: string): string | undefined {
  const base = root.replace(/\/+$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined
}

// ------------------------------------------------------- protected files

export type Kind = 'progress' | 'plans'

const PLANS = 'docs/superpowers/plans'

// What a path inside the repo is, from its path under the repo root. Case
// is ignored: the Mac's file system is.
export function kindOfRel(rel: string): Kind | undefined {
  const r = normalize(rel).toLowerCase()
  if (r === 'progress.md') return 'progress'
  if (r === PLANS || r.startsWith(`${PLANS}/`)) return 'plans'
  return undefined
}

// A cheap test before any git call: could this path be one of them?
export function couldBeProtected(path: string): boolean {
  const p = path.toLowerCase()
  return hasGlob(p) || basename(p) === 'progress.md' || p.includes(`/${PLANS}/`) || p.endsWith(`/${PLANS}`)
}

export function hasGlob(path: string): boolean {
  return /[*?[{]/.test(path)
}

// `*` stays inside one folder, `**` crosses folders, `{a,b}` and `[a-z]` as
// in zsh. Case-insensitive, matching the whole string.
export function globRegex(pattern: string): RegExp {
  let out = ''
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i)
    if (c === '*') {
      if (pattern.charAt(i + 1) === '*') {
        i += 1
        if (pattern.charAt(i + 1) === '/') {
          i += 1
          out += '(?:.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end === -1) out += '\\['
      else {
        const body = pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')
        out += `[${body}]`
        i = end
      }
    } else if (c === '{') {
      depth += 1
      out += '(?:'
    } else if (c === '}' && depth > 0) {
      depth -= 1
      out += ')'
    } else if (c === ',' && depth > 0) out += '|'
    else out += c.replace(/[\\^$.+()|[\]{}]/g, '\\$&')
  }
  return new RegExp(`^${out}${')'.repeat(depth)}$`, 'i')
}

// A glob path split at its first wildcard: the folder that is literal, and
// the rest, which is a pattern relative to that folder.
export function splitGlob(path: string): { dir: string; rest: string } {
  const at = path.search(/[*?[{]/)
  const cut = path.lastIndexOf('/', at)
  return { dir: cut <= 0 ? '/' : path.slice(0, cut), rest: path.slice(cut + 1) }
}

// Whether a pattern, relative to the repo root, can match PROGRESS.md or
// something under the plans folder. `planFiles` are the real names there.
export function globHitsProtected(relPattern: string, planFiles: readonly string[]): boolean {
  const re = globRegex(relPattern)
  const names = ['PROGRESS.md', PLANS, `${PLANS}/x.md`, ...planFiles.map(f => `${PLANS}/${f}`)]
  return names.some(n => re.test(n))
}

// What a Read call may do with a protected file: undefined when it is fine,
// else the reason. A `limit` of 1 to MAX_LINES lines passes.
export function limitProblem(limit: unknown): 'missing' | 'too-large' | undefined {
  const n =
    typeof limit === 'number' ? limit : typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : NaN
  if (!Number.isInteger(n) || n < 1) return 'missing'
  return n > MAX_LINES ? 'too-large' : undefined
}

const NAME = { progress: 'PROGRESS.md', plans: 'a file in docs/superpowers/plans/' } as const

const HOW = {
  progress:
    "Find the section's heading first (Grep, or `grep -n '^## ' PROGRESS.md` for the list, or `grep -n '^## 76\\.' PROGRESS.md` for one section): " +
    'the headings are `## N. title`, and after §13b the newest section comes first.',
  plans:
    "Find the heading first (`grep -n '^#' <file>`, or Grep for the unit or task you need): " +
    'a plan is a record, split into `##` sections and `### Task` blocks.',
} as const

export function readDeny(kind: Kind, rel: string, problem: 'missing' | 'too-large'): string {
  const why =
    problem === 'missing'
      ? `this Read has no \`limit\`, and ${NAME[kind]} is far too big to read whole (AGENTS.md says never to).`
      : `this Read's \`limit\` is over ${MAX_LINES} lines, which is not a section of ${NAME[kind]} (AGENTS.md says never to read it whole).`
  return (
    `boe-guard refused the read of ${rel}: ${why} ${HOW[kind]} ` +
    `Then call Read again on the same file with \`offset\` at that heading's line and \`limit\` set to the section's length (at most ${MAX_LINES}).`
  )
}

export function dumpDeny(kind: Kind, rel: string): string {
  return (
    `boe-guard refused this command: it would print all of ${rel} (${NAME[kind]}), and AGENTS.md says never to read it whole. ` +
    `${HOW[kind]} ` +
    `Then print just that part: \`sed -n 'START,ENDp' ${rel}\`, \`head\`/\`grep\` on it, or the Read tool with \`offset\` and \`limit\`.`
  )
}

// ----------------------------------------------------------- the parser

const DOLLAR = '' // a `$` that quotes made literal
const SUBST = '' // a `$(...)` or backtick result, not known here

export type Tok =
  | { t: 'w'; v: string }
  | { t: 'op'; v: string }
  | { t: 'r'; op: string; v: string }
  | { t: 'sub'; v: string }

const REDIRECT = /^(?:&>>?|<<<|<<-?|<>|<&|>>|>&|>\||<|>)/

function closingQuote(s: string, open: number): number {
  for (let j = open + 1; j < s.length; j++) {
    if (s.charAt(j) === '\\') j += 1
    else if (s.charAt(j) === '"') return j
  }
  return s.length
}

// The index of the `)` that closes the `(` at `open`, or the end of text.
function closingParen(s: string, open: number): number {
  let depth = 0
  for (let j = open; j < s.length; j++) {
    const c = s.charAt(j)
    if (c === '\\') j += 1
    else if (c === "'") {
      const end = s.indexOf("'", j + 1)
      if (end === -1) return s.length
      j = end
    } else if (c === '"') j = closingQuote(s, j)
    else if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return j
    }
  }
  return s.length
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  const heredocs: { delim: string; strip: boolean }[] = []
  const n = src.length
  let buf = ''
  let has = false
  let redir: string | undefined
  let i = 0

  const endWord = () => {
    if (!has) return
    if (redir !== undefined) {
      toks.push({ t: 'r', op: redir, v: buf })
      if (redir.startsWith('<<') && redir !== '<<<') heredocs.push({ delim: buf, strip: redir === '<<-' })
      redir = undefined
    } else toks.push({ t: 'w', v: buf })
    buf = ''
    has = false
  }
  const sub = (inner: string) => {
    toks.push({ t: 'sub', v: inner })
    buf += SUBST
    has = true
  }

  while (i < n) {
    const c = src.charAt(i)
    const next = src.charAt(i + 1)
    if (c === '\\') {
      if (next !== '\n' && i + 1 < n) {
        buf += next === '$' ? DOLLAR : next
        has = true
      }
      i += 2
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      buf += src.slice(i + 1, end === -1 ? n : end).replaceAll('$', DOLLAR)
      has = true
      i = end === -1 ? n : end + 1
    } else if (c === '"') {
      has = true
      i += 1
      while (i < n && src.charAt(i) !== '"') {
        const d = src.charAt(i)
        const e = src.charAt(i + 1)
        if (d === '\\' && i + 1 < n) {
          if (e === '$') buf += DOLLAR
          else if (e === '\n') buf += ''
          else if ('`"\\'.includes(e)) buf += e
          else buf += d + e
          i += 2
        } else if (d === '$' && e === '(') {
          const end = closingParen(src, i + 1)
          sub(src.slice(i + 2, end))
          i = end + 1
        } else if (d === '`') {
          const end = src.indexOf('`', i + 1)
          sub(src.slice(i + 1, end === -1 ? n : end))
          i = end === -1 ? n : end + 1
        } else {
          buf += d
          i += 1
        }
      }
      i += 1
    } else if (c === '$' && next === '(') {
      const end = closingParen(src, i + 1)
      sub(src.slice(i + 2, end))
      i = end + 1
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1)
      sub(src.slice(i + 1, end === -1 ? n : end))
      i = end === -1 ? n : end + 1
    } else if (c === '#' && !has) {
      while (i < n && src.charAt(i) !== '\n') i += 1
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i += 1
    } else if (c === '\n') {
      endWord()
      redir = undefined
      toks.push({ t: 'op', v: '\n' })
      i += 1
      for (const doc of heredocs.splice(0)) {
        for (;;) {
          if (i >= n) break
          const stop = src.indexOf('\n', i)
          const line = src.slice(i, stop === -1 ? n : stop)
          i = stop === -1 ? n : stop + 1
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break
        }
      }
    } else if ((c === '<' || c === '>') && next === '(') {
      const end = closingParen(src, i + 1)
      sub(src.slice(i + 2, end))
      i = end + 1
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      // A number glued in front (`2>`) belongs to the operator.
      if (has && /^\d+$/.test(buf)) {
        buf = ''
        has = false
      } else endWord()
      const op = REDIRECT.exec(src.slice(i))?.[0] ?? c
      redir = op
      i += op.length
    } else if (c === '&' || c === '|' || c === ';' || c === '(' || c === ')') {
      endWord()
      redir = undefined
      const op = (c === '&' || c === '|') && next === c ? c + c : c === '|' && next === '&' ? '|&' : c
      toks.push({ t: 'op', v: op })
      i += op.length
    } else {
      buf += c
      has = true
      i += 1
    }
  }
  endWord()
  return toks
}

export type Step = {
  // The program and its arguments: quotes gone, `$VAR` and `~` filled in
  // where known, `VAR=x` prefixes and wrappers like `env` and `time` removed.
  words: string[]
  stdin: string[] // targets of `<` redirects
  dir: string // where it runs, after the `cd`s before it
  after: string[] // programs later in the same pipe
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const RESERVED = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
const WRAPPERS = new Set(['time', 'nohup', 'exec', 'command', 'builtin', 'caffeinate'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const MAX_DEPTH = 5

export const program = (step: Step): string => basename(step.words[0] ?? '')

function interpret(src: string, start: string, vars: Map<string, string>, depth: number, out: Step[], home: string) {
  const toks = tokenize(src)
  let dir = start
  let words: string[] = []
  let stdin: string[] = []
  let pipe: Step[] = []

  const expand = (word: string) =>
    (word === '~' || word.startsWith('~/') ? home + word.slice(1) : word).replace(
      /\$\{(\w+)\}|\$(\w+)/g,
      (whole: string, a?: string, b?: string) => {
        const name = a ?? b ?? ''
        if (name === 'HOME') return home
        if (name === 'PWD') return dir
        return vars.get(name) ?? whole
      },
    )
  const restore = (word: string) => word.replaceAll(DOLLAR, '$')
  const setVar = (assignment: string) => {
    const eq = assignment.indexOf('=')
    vars.set(assignment.slice(0, eq), assignment.slice(eq + 1))
  }
  const closePipe = () => {
    pipe.forEach((step, k) => {
      step.after = pipe.slice(k + 1).map(program)
    })
    out.push(...pipe)
    pipe = []
  }

  const command = () => {
    const given = stdin
    let w = words.map(expand)
    words = []
    stdin = []
    let a = 0
    while (a < w.length && ASSIGN.test(w[a] ?? '')) a += 1
    const assignments = w.slice(0, a)
    w = w.slice(a)
    if (w.length === 0) {
      for (const x of assignments) setVar(x)
      return
    }
    for (;;) {
      const first = w[0] ?? ''
      if (RESERVED.has(first)) w = w.slice(1)
      else if (basename(first) === 'env') {
        let k = 1
        while (k < w.length && ((w[k] ?? '').startsWith('-') || ASSIGN.test(w[k] ?? ''))) {
          k += (w[k] === '-u' ? 2 : 1)
        }
        w = w.slice(k)
      } else if (WRAPPERS.has(basename(first))) {
        let k = 1
        while (k < w.length && (w[k] ?? '').startsWith('-')) k += 1
        w = w.slice(k)
      } else break
      if (w.length === 0) return
    }
    const prog = basename(w[0] ?? '')
    if (prog === 'export') {
      for (const x of w.slice(1)) if (ASSIGN.test(x)) setVar(x)
      return
    }
    if (prog === 'cd' || prog === 'pushd') {
      const target = w.slice(1).find(x => !x.startsWith('-'))
      if (target === undefined) dir = home || dir
      else if (!target.includes(SUBST) && !target.includes('$') && target !== '-') {
        dir = normalize(target.startsWith('/') ? target : `${dir}/${target}`)
      }
      return
    }
    if (depth < MAX_DEPTH) {
      if (SHELLS.has(prog)) {
        const k = w.findIndex((x, at) => at > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x))
        const script = k === -1 ? undefined : w[k + 1]
        if (script !== undefined) {
          interpret(restore(script), dir, new Map(vars), depth + 1, out, home)
          return
        }
      }
      if (prog === 'eval') {
        interpret(restore(w.slice(1).join(' ')), dir, new Map(vars), depth + 1, out, home)
        return
      }
    }
    pipe.push({ words: w.map(restore), stdin: given.map(x => restore(expand(x))), dir, after: [] })
  }

  for (const tok of toks) {
    if (tok.t === 'w') words.push(tok.v)
    else if (tok.t === 'r') {
      if (tok.op === '<') stdin.push(tok.v)
    } else if (tok.t === 'sub') {
      if (depth < MAX_DEPTH) interpret(tok.v, dir, new Map(vars), depth + 1, out, home)
    } else {
      command()
      if (tok.v !== '|' && tok.v !== '|&') closePipe()
    }
  }
  command()
  closePipe()
}

// A command line as the simple commands it runs. Never throws.
export function parseSteps(command: string, ctx: Context): Step[] {
  const out: Step[] = []
  try {
    interpret(command, ctx.cwd, new Map(), 0, out, ctx.home)
  } catch {
    // A parser bug must not stop the session; the hooks that call this
    // only act on what it found.
  }
  return out
}

// -------------------------------------------------------- whole-file dumps

const DUMPERS = new Set(['cat', 'tac', 'less', 'more', 'bat', 'batcat', 'nl'])
// A pipe into one of these narrows the output, so the dump is not whole.
const NARROWERS = new Set(['head', 'tail', 'sed', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'wc'])

// The files a command prints in full: `cat`, `less`, `more` and the like on
// a path (or `< path`) that no pipe narrows. Absolute, clean; a path with
// wildcards is returned as written.
export function dumpTargets(command: string, ctx: Context): string[] {
  const found: string[] = []
  for (const step of parseSteps(command, ctx)) {
    if (!DUMPERS.has(program(step))) continue
    if (step.after.some(p => NARROWERS.has(p))) continue
    const files = [...step.words.slice(1).filter(w => w !== '-' && !/^[-+]/.test(w)), ...step.stdin]
    for (const file of files) {
      if (file.includes(SUBST) || /\$[{\w]/.test(file)) continue
      found.push(absolutePath(file, { cwd: step.dir, home: ctx.home }))
    }
  }
  return found
}

// A cheap look at the text before parsing it and asking the engine for the
// session folder: does the command name a program of this kind at all?
export const mayDump = (command: string): boolean => /\b(?:cat|tac|less|more|bat|batcat|nl)\b/.test(command)
export const mayLoad = (command: string): boolean => command.includes('boe_agent')

// ----------------------------------------------------------- data loads

export type Source = 'bdns' | 'boe'

export type Load = {
  module: string
  source: Source | undefined
  dir: string
  // Set when the command names the days it loads.
  from?: string
  to?: string
  months?: string[]
  // What the command does not say, or does besides loading.
  note?: string
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

export function isIsoDay(text: string): boolean {
  const m = ISO.exec(text)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const at = new Date(Date.UTC(y, mo - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d
}

// The months from the one holding `from` to the one holding `to`.
export function monthsBetween(from: string, to: string): string[] {
  const [a, b] = from <= to ? [from, to] : [to, from]
  let y = Number(a.slice(0, 4))
  let m = Number(a.slice(5, 7))
  const last = b.slice(0, 7)
  const months: string[] = []
  for (let guard = 0; guard < 1200; guard++) {
    const label = `${y}-${String(m).padStart(2, '0')}`
    months.push(label)
    if (label >= last) break
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return months
}

const LIVE_MODULES = ['ingesta_de_un_dia', 'barrido', 'barrido_boe', 'recogida_boe', 'cola'] as const

const SOURCE_OF = new Map<string, Source>([
  ['ingesta_de_un_dia', 'bdns'],
  ['barrido', 'bdns'],
  ['barrido_boe', 'boe'],
  ['recogida_boe', 'boe'],
])

// How many days each command takes: one day, or a first and a last.
const DAYS_TAKEN = new Map<string, number>([
  ['ingesta_de_un_dia', 1],
  ['barrido', 2],
  ['barrido_boe', 2],
  ['recogida_boe', 1],
])

// The load a `boe_agent.comandos.<name>` run makes, or undefined for a run
// that sends nothing to BDNS or BOE (read-only modes, the queue's own
// bookkeeping, projections from the database, a usage message).
export function loadOf(name: string, args: readonly string[], dir: string): Load | undefined {
  if (name === 'cola') {
    if (args[0] !== 'procesar') return undefined
    const source = args[1] === 'bdns' || args[1] === 'boe' ? args[1] : undefined
    const max = args[2] === '--maximo' && /^\d+$/.test(args[3] ?? '') ? Number(args[3]) : undefined
    const limit = max === undefined ? 'every day' : `at most ${max} days`
    return {
      module: name,
      source,
      dir,
      note: `the command names no month: it takes the days already queued (${limit}), so the month is whatever was queued`,
    }
  }
  const taken = DAYS_TAKEN.get(name)
  if (taken === undefined) return undefined
  if (args[0] === '--completitud') return undefined
  if (args.length === 0) return undefined
  const source = SOURCE_OF.get(name)
  const flags = args.filter(a => a.startsWith('--'))
  const days = args.filter(a => !a.startsWith('--'))
  const reobserve = flags.includes('--re-observar')
  const extra = reobserve ? 're-asks BOE for the announcements already stored' : undefined
  if (days.length === taken && days.every(isIsoDay)) {
    const from = days[0] ?? ''
    const to = days[days.length - 1] ?? from
    return { module: name, source, dir, from, to, months: monthsBetween(from, to), note: extra }
  }
  const named = days.join(' ')
  return {
    module: name,
    source,
    dir,
    note: `the month is not clear from the command (${named === '' ? 'no days' : named.includes('$') ? `it uses a shell variable: ${named}` : `not plain YYYY-MM-DD days: ${named}`})`,
  }
}

type ModuleRun = { names: string[]; args: string[]; dir: string }

const PYTHON = /^python(\d+(\.\d+)*)?$/
const MODULE = /^boe_agent\.comandos\.(?:([a-z_]+)|\{([a-z_,]+)\})$/

// `python -m boe_agent.comandos.X ...`, also through `uv run` and with the
// folder `uv run --directory D` names.
function moduleRun(step: Step): ModuleRun | undefined {
  const prog = program(step)
  const isUv = prog === 'uv' && step.words.includes('run')
  const isPython = PYTHON.test(prog) || (isUv && step.words.some(w => PYTHON.test(basename(w))))
  if (!isUv && !isPython) return undefined
  let dir = step.dir
  for (let k = 1; k < step.words.length; k++) {
    const word = step.words[k] ?? ''
    const given = /^--(?:directory|project)=(.+)$/.exec(word)?.[1]
    const folder = given ?? (word === '--directory' || word === '--project' ? step.words[k + 1] : undefined)
    if (folder !== undefined) dir = absolutePath(folder, { cwd: dir, home: '' })
    const glued = word.length > 2 && word.startsWith('-m') && !word.startsWith('--') ? word.slice(2) : undefined
    if (word !== '-m' && glued === undefined) continue
    const spec = glued ?? step.words[k + 1] ?? ''
    const m = MODULE.exec(spec)
    if (!m) return undefined
    const names = (m[1] ?? m[2] ?? '').split(',').filter(Boolean)
    return { names, args: step.words.slice(glued === undefined ? k + 2 : k + 1), dir }
  }
  // `python -c "..."` that imports a load command.
  const code = step.words.indexOf('-c')
  if (code !== -1 && isPython) {
    const text = step.words[code + 1] ?? ''
    const names = LIVE_MODULES.filter(
      name => new RegExp(String.raw`boe_agent\.comandos(?:\.${name}\b|\s+import\s+[\w\s,]*\b${name}\b)`).test(text),
    )
    if (names.length > 0) return { names: [...names], args: ['(python -c)'], dir }
  }
  return undefined
}

// The loads a Bash command makes. `dir` is where each one runs, for the
// caller to test against the repo.
export function findLoads(command: string, ctx: Context): Load[] {
  const loads: Load[] = []
  for (const step of parseSteps(command, ctx)) {
    const run = moduleRun(step)
    if (!run) continue
    for (const name of run.names) {
      if (run.args[0] === '(python -c)') {
        loads.push({
          module: name,
          source: SOURCE_OF.get(name),
          dir: run.dir,
          note: 'it runs inside python -c, so the month is not visible',
        })
        continue
      }
      const load = loadOf(name, run.args, run.dir)
      if (load) loads.push(load)
    }
  }
  return loads
}

const SOURCE_NAME: Record<Source, string> = {
  bdns: 'BDNS (infosubvenciones.es)',
  boe: 'BOE section 5A (boe.es)',
}

export function describeLoad(load: Load): string {
  const source = load.source === undefined ? 'BDNS or BOE (not clear from the command)' : SOURCE_NAME[load.source]
  const parts = [source]
  const months = load.months ?? []
  if (months.length === 1) parts.push(`month ${months[0]}`)
  else if (months.length > 1) parts.push(`months ${months[0]} to ${months[months.length - 1]} (${months.length} months)`)
  if (load.from !== undefined && load.to !== undefined) {
    parts.push(load.from === load.to ? `day ${load.from}` : `days ${load.from} to ${load.to}`)
  }
  if (load.note !== undefined) parts.push(load.note)
  return parts.join(', ')
}

// Shown in the permission dialog, and read by the model when nobody can be
// asked (a refused ask is an error result carrying this text).
export function loadReason(loads: readonly Load[]): string {
  const what =
    loads.length === 1
      ? `this command loads data from ${describeLoad(loads[0] as Load)}.`
      : `this command makes ${loads.length} loads:\n${loads.map(l => `- ${describeLoad(l)}`).join('\n')}\n\n`
  return (
    `boe-guard: ${what}${loads.length === 1 ? ' ' : ''}` +
    'Each load is a deliberate run against a public service and writes the database, so the person confirms every one. ' +
    'Allow it only for that source and month. ' +
    'If no one can answer, do not run it: ask the user in chat to confirm the source and month first.'
  )
}
