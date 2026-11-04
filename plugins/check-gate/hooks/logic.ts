import type { Run, Step, StepStatus } from '../types'

// The working tree's fingerprint, from content alone: one `ls-files -s` line
// per file on disk that git would keep (mode, blob hash, path), taken from the
// index where the file matches it and hashed from disk where it differs or is
// untracked. Staging, committing, a staged rename or a `git rm` leave it as
// it was, so a result outlives `git add` and the commit itself. Read-only:
// nothing is written to .git.
export const FINGERPRINT = `
changed=$(git -c core.quotePath=false diff --name-only --no-renames 2>/dev/null)
files=$({
  printf '%s\\n' "$changed"
  git -c core.quotePath=false ls-files -o --exclude-standard
} 2>/dev/null | LC_ALL=C sort -u | while IFS= read -r f; do [ -f "$f" ] && printf '%s\\n' "$f"; done)
{
  git -c core.quotePath=false ls-files -s | CHANGED="$changed" awk -F '\\t' '
    BEGIN { n = split(ENVIRON["CHANGED"], a, "\\n"); for (i = 1; i <= n; i++) skip[a[i]] = 1 }
    !($2 in skip)'
  if [ -n "$files" ]; then
    printf '%s\\n' "$files" | git hash-object --stdin-paths | while IFS= read -r h && IFS= read -r f <&3; do
      if [ -L "$f" ]; then m=120000; elif [ -x "$f" ]; then m=100755; else m=100644; fi
      printf '%s %s 0\\t%s\\n' "$m" "$h" "$f"
    done 3<<EOF
$files
EOF
  fi
} 2>/dev/null | LC_ALL=C sort | git hash-object --stdin
`

// One shell word: plain characters, backslash escapes and quoted runs.
const WORD = String.raw`(?:[^\s"'\\;&|()]|\\.|"[^"]*"|'[^']*')+`
// Each option reads one way only: the catch-all forms skip what takes a separate
// value, and a word's parts don't overlap. Any choice here makes the regex exponential.
const TAKES_NEXT_WORD = String.raw`(?:-[Cc]|--(?:git-dir|work-tree|namespace|super-prefix|config-env))\s`
const GIT_OPTION = String.raw`(?:-[Cc]\s+${WORD}|--(?:git-dir|work-tree|namespace|super-prefix|config-env)\s+${WORD}|(?!${TAKES_NEXT_WORD})--[A-Za-z][\w-]*(?:=${WORD})?|(?!${TAKES_NEXT_WORD})-[A-Za-z]+)`
// `-c commit.<key>` counts as a commit: sessions set it around `"$@"` or before a
// `rebase --exec`, where the real subcommand is out of sight.
const GIT_COMMIT = new RegExp(
  String.raw`(?:^|[\s;&|(\x60/])git((?:\s+${GIT_OPTION})*)\s+(?:commit(?![\w-])|-c\s+commit\.)`,
  'g',
)

// A word as the shell reads it. `isDynamic`: its value depends on the shell (a
// variable, a substitution, a glob). `hasBareVariable`: a variable outside quotes.
type Word = { text: string; isDynamic: boolean; hasBareVariable: boolean }
type Token = Word | { op: string }

const OPERATOR = /^(?:;;&|;;|;&|&&|\|\||\|&|[;&|()\n])/
const REDIRECT = /^(?:&>>?|\d*(?:>>|>&|<&|<>|>\||>|<<<|<<-?|<))/

// `((...))` with at most one level of parentheses inside. Each `(` reads one way, so
// a failed try ends at the second one down, and `((a); (b))` stays two subshells.
const ARITHMETIC_TEXT = String.raw`\(\((?:[^()]|\([^()]*\))*\)\)`
const ARITHMETIC = new RegExp(`^${ARITHMETIC_TEXT}`)
// `$((...))`, or `$'...'`, where a backslash can escape the closing quote.
const OPAQUE = new RegExp(String.raw`^\$(?:'(?:[^'\\]|\\[\s\S])*'|${ARITHMETIC_TEXT})`)

// Reads the `"` or backtick string at `open`. `end` is where it closes, or -1. When
// the text ends inside a `$(...)` or backtick in a `"` string, `inside` is where that
// substitution's commands start. A backtick closes at the next backtick, whatever it holds.
function scanString(text: string, open: number): { end: number; inside?: number } {
  const quote = text.charAt(open)
  let i = open + 1
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === quote) return { end: i }
    if (c === '\\') {
      i += 2
    } else if (quote === '"' && (c === '`' || text.startsWith('$(', i))) {
      const end = c === '`' ? scanString(text, i).end : closingParen(text, i + 1)
      if (end === -1) return { end: -1, inside: c === '`' ? i + 1 : i + 2 }
      i = end + 1
    } else {
      i += 1
    }
  }
  return { end: -1 }
}

// Where the `(` at `open` closes, reading what it holds as shell text, so a `)` in a
// string, a comment or a heredoc doesn't count; -1 if it doesn't close.
function closingParen(text: string, open: number): number {
  const { closesAt } = lex(text.slice(open + 1), 'paren')
  return closesAt === undefined ? -1 : open + 1 + closesAt
}

function readWord(text: string, start: number): { word: Word; end: number } | { openQuote: number } {
  let out = ''
  let isDynamic = false
  let hasBareVariable = false
  let i = start
  // A quoted `~` at the start of a value is a folder called ~, which `./` keeps from reading as home.
  const quoted = (piece: string) => {
    out += piece.startsWith('~') && (out === '' || out.endsWith('=')) ? `./${piece}` : piece
  }
  while (i < text.length) {
    const c = text.charAt(i)
    if (/[\s;&|()<>]/.test(c)) break
    const opaque = c === '$' ? OPAQUE.exec(text.slice(i))?.[0] : undefined
    if (opaque !== undefined) {
      // Kept as written, `$` and all, so the walk won't take the word for a folder it can read.
      isDynamic = true
      out += opaque
      i += opaque.length
    } else if (c === '$' && text.charAt(i + 1) === "'") {
      return { openQuote: i + 1 }
    } else if (c === '\\') {
      if (text.charAt(i + 1) !== '\n') quoted(text.charAt(i + 1))
      i += 2
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) return { openQuote: i }
      quoted(text.slice(i + 1, end))
      i = end + 1
    } else if (c === '"' || c === '`') {
      const { end } = scanString(text, i)
      if (end === -1) return { openQuote: i }
      const inner = text.slice(i + 1, end)
      if (c === '`' || /[$`]/.test(inner)) isDynamic = true
      if (c === '`') out += text.slice(i, end + 1)
      else quoted(inner.replace(/\\(["\\$`])/g, '$1'))
      i = end + 1
    } else {
      if (/[$*?[{]/.test(c)) isDynamic = true
      if (c === '$') hasBareVariable = true
      out += c
      i += 1
    }
  }
  return { word: { text: out, isDynamic, hasBareVariable }, end: i }
}

// The line after a run of heredocs whose bodies start after `newline`, or -1
// when the text ends inside a body.
function afterHeredocs(text: string, newline: number, heredocs: readonly { tag: string; isTabbed: boolean }[]): number {
  let at = newline + 1
  for (const { tag, isTabbed } of heredocs) {
    let isClosed = false
    while (at < text.length && !isClosed) {
      const end = text.indexOf('\n', at)
      const line = text.slice(at, end === -1 ? text.length : end)
      at = end === -1 ? text.length : end + 1
      isClosed = (isTabbed ? line.replace(/^\t+/, '') : line) === tag
    }
    if (!isClosed) return -1
  }
  return at
}

// Splits shell text into words and operators, dropping comments, redirections
// and heredoc bodies. `openQuote` is where it stopped at a quote that never
// closes, as when the text ends inside a string; `inHeredoc`, that it ended
// inside a heredoc body. `stopAt: 'paren'` ends it at the first `)` it didn't
// open, and `closesAt` says where.
function lex(text: string, stopAt?: 'paren'): { tokens: Token[]; openQuote?: number; inHeredoc?: boolean; closesAt?: number } {
  const tokens: Token[] = []
  let heredocs: { tag: string; isTabbed: boolean }[] = []
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === '\n') {
      tokens.push({ op: '\n' })
      i = afterHeredocs(text, i, heredocs)
      if (i === -1) return { tokens, inHeredoc: true }
      heredocs = []
    } else if (/\s/.test(c)) {
      i += 1
    } else if (text.startsWith('\\\n', i)) {
      i += 2
    } else if (c === '#') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
    } else {
      const rest = text.slice(i)
      const arithmetic = c === '(' ? ARITHMETIC.exec(rest)?.[0] : undefined
      if (arithmetic !== undefined) {
        tokens.push({ text: arithmetic, isDynamic: true, hasBareVariable: false })
        i += arithmetic.length
        continue
      }
      const redirect = REDIRECT.exec(rest)?.[0]
      const op = OPERATOR.exec(rest)?.[0]
      if (redirect !== undefined) {
        i += redirect.length
        while (text.charAt(i) === ' ' || text.charAt(i) === '\t') i += 1
      } else if (op !== undefined) {
        if (stopAt === 'paren' && op === ')' && depth === 0) return { tokens, closesAt: i }
        if (op === '(') depth += 1
        else if (op === ')') depth -= 1
        tokens.push({ op })
        i += op.length
        continue
      }
      const read = readWord(text, i)
      if ('openQuote' in read) return { tokens, openQuote: read.openQuote }
      i = read.end
      if (redirect === undefined) tokens.push(read.word)
      else if (redirect.includes('<<') && !redirect.includes('<<<')) {
        heredocs.push({ tag: read.word.text, isTabbed: redirect.endsWith('-') })
      }
    }
  }
  return { tokens }
}

// Where the commands so far have left the shell. `dir` undefined is where it started.
type Place = {
  dir: string | undefined
  // Variables the command has set to text the walk can read.
  vars: Map<string, string>
  // This && chain has run a command that can fail.
  chainCanFail: boolean
  // A move sits behind that command, so it only holds while the chain goes on.
  isGuarded: boolean
  // This list holds a move, and a `&` at its end sends the whole list to a subshell.
  listMoved: boolean
  // One per open if, loop, case or brace group: has the folder moved inside it?
  blocks: boolean[]
  unplaced?: string
  // The text ends inside a string or a heredoc, so this "commit" is likely a mention.
  isMention?: boolean
  // The command has defined a function, so a block still open may be its body.
  definesFunction?: boolean
}

const BEFORE_COMMAND = new Set(['then', 'do', '!', 'time', 'builtin'])
const MOVES = new Set(['cd', 'chdir', 'pushd', 'popd'])
const BLOCK_OPEN = new Set(['if', 'while', 'until', '{'])
const BLOCK_OPEN_WITH_ARGS = new Set(['for', 'case', 'select'])
const BLOCK_BRANCH = new Set(['else', 'elif'])
const BLOCK_CLOSE = new Set(['fi', 'done', 'esac', '}'])
// An empty CDPATH is the usual way to turn it off, so only a value counts.
const REPO_VARIABLE = /^(?:GIT_DIR=|GIT_WORK_TREE=|CDPATH=.)/
// A shell's flags before its `-c`: `-o pipefail`, `--rcfile x`, `--norc`, `+x`. Each one
// reads one way only, for the same reason as GIT_OPTION.
const SHELL_FLAGS = String.raw`(?:\s+(?:[-+]\w*[oO]\s+\w+|--(?:rcfile|init-file)\s+[^\s-]\S*|[-+][-\w]*))*`
const NESTED_SHELL = new RegExp(String.raw`(?:^|[\s;&|(/])(?:(?:ba|z|da|k)?sh${SHELL_FLAGS}\s+-\w*c\w*(?:\s+[-+][-\w]*)*|eval)\s*\$?$`)
const ASSIGNMENT = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/
const DECLARES = new Set(['export', 'declare', 'typeset', 'readonly'])
// These set or drop a variable their arguments name, to a value the walk can't read.
// `local` outside a function fails in bash and works in zsh, so what it sets depends on the shell.
const CLEARS = new Set(['unset', 'read', 'local', 'printf', 'getopts', 'mapfile', 'readarray'])
const VARIABLE = /\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/g

const REPO_VARIABLE_REASON = 'GIT_DIR, GIT_WORK_TREE or CDPATH is set in the command'
const INSIDE_BLOCK_REASON = 'a cd inside an if, loop, case or braces that ended before the commit'
const SUBSHELL_REASON = 'a cd in a pipeline or the background, which keeps it to itself'
const FUNCTION_REASON = 'a commit inside a function, which runs wherever the function is called'

const startingVars = () => new Map([['HOME', '~']])

// A word's value, with the variables the command set filled in. Undefined when
// it still depends on the shell. An unquoted variable holding a space splits in
// bash and not in zsh, so that depends on the shell too.
function valueOf(word: Word, vars: ReadonlyMap<string, string>): string | undefined {
  if (!word.isDynamic) return word.text
  const value = word.text.replace(VARIABLE, (whole: string, plain?: string, braced?: string) => vars.get(plain ?? braced ?? '') ?? whole)
  if (/[$`*?[{]/.test(value)) return undefined
  return word.hasBareVariable && /\s/.test(value) ? undefined : value
}

// A word's value as a folder the walk can follow, else undefined.
function pathOf(word: Word, vars: ReadonlyMap<string, string>): string | undefined {
  const value = valueOf(word, vars)
  if (value === undefined || value === '' || value.startsWith('-') || /^~[^/]/.test(value)) return undefined
  if (!value.startsWith('~')) return value
  const home = vars.get('HOME')
  return home === undefined ? undefined : home + value.slice(1)
}

// Records `NAME=value`, or forgets NAME when the value or the assignment isn't certain.
function recordAssignment(place: Place, word: Word, isCertain: boolean): void {
  const [, name, append, rest] = ASSIGNMENT.exec(word.text) ?? []
  if (name === undefined) return
  const value = isCertain && !append ? valueOf({ ...word, text: rest ?? '', hasBareVariable: false }, place.vars) : undefined
  if (value === undefined) place.vars.delete(name)
  else place.vars.set(name, value)
}

const shellOnly = (shown: string) => `${shown}, a folder only the shell can work out`

const joinPath = (base: string | undefined, path: string) =>
  base === undefined || path.startsWith('/') || path.startsWith('~')
    ? path
    : `${base.replace(/\/+$/, '')}/${path}`

// Applies a cd or pushd, or records why it can't. `cd -` and `popd` go back to
// an earlier folder, which hides a cd that failed on the way: `cd a; cd missing;
// cd -` ends in the folder `cd a` left, so the walk would name the wrong one.
function applyMove(place: Place, name: string, args: readonly Word[]): void {
  const shown = [name, ...args.map(arg => arg.text)].join(' ')
  const [arg] = args
  if (name === 'popd' || arg?.text === '-') {
    place.unplaced ??= `${shown}, which goes back to a folder the gate can't be sure of`
  } else if (arg === undefined) {
    const home = place.vars.get('HOME')
    if (name === 'pushd') place.unplaced ??= 'pushd with no folder'
    else if (home === undefined) place.unplaced ??= shellOnly(`${shown} with HOME unset`)
    else place.dir = joinPath(place.dir, home)
  } else {
    const path = args.length === 1 ? pathOf(arg, place.vars) : undefined
    if (path === undefined) place.unplaced ??= shellOnly(shown)
    else place.dir = joinPath(place.dir, path)
  }
}

// Runs one simple command against the place. True when it moved the folder.
function runCommand(place: Place, words: readonly Word[], connector: string | undefined, next: string | undefined): boolean {
  // Whether a variable set here stays set in this shell at the commit.
  const isCertain =
    place.blocks.length === 0 &&
    connector !== '||' &&
    connector !== '|' &&
    connector !== '|&' &&
    !(connector === '&&' && place.chainCanFail) &&
    next !== '&' &&
    next !== '|' &&
    next !== '|&'
  let i = 0
  for (; i < words.length; i++) {
    const text = words[i]?.text ?? ''
    if (REPO_VARIABLE.test(text)) place.unplaced ??= REPO_VARIABLE_REASON
    if (text === 'function') {
      place.definesFunction = true
      i += 1
    } else if (text === 'time' && words[i + 1]?.text === '-p') i += 1
    else if (BLOCK_OPEN.has(text)) place.blocks.push(false)
    else if (BLOCK_OPEN_WITH_ARGS.has(text)) {
      place.blocks.push(false)
      place.vars.delete(words[i + 1]?.text ?? '')
      return false
    } else if (BLOCK_BRANCH.has(text)) {
      if (place.blocks.at(-1)) place.unplaced ??= INSIDE_BLOCK_REASON
    } else if (BLOCK_CLOSE.has(text)) {
      if (place.blocks.pop()) place.unplaced ??= INSIDE_BLOCK_REASON
    } else if (!BEFORE_COMMAND.has(text) && !ASSIGNMENT.test(text)) break
  }
  const name = words[i]?.text
  if (name === undefined) {
    // Nothing but assignments: they stay. Before a command they last for that command alone.
    for (const word of words) recordAssignment(place, word, isCertain)
    return false
  }
  const args = words.slice(i + 1)
  if ((DECLARES.has(name) || CLEARS.has(name) || name === 'env') && args.some(arg => REPO_VARIABLE.test(arg.text))) {
    place.unplaced ??= REPO_VARIABLE_REASON
  }
  if (DECLARES.has(name)) for (const arg of args) recordAssignment(place, arg, isCertain)
  if (CLEARS.has(name)) for (const arg of args) place.vars.delete(arg.text.split('=', 1)[0] ?? '')
  if (name === 'eval') place.unplaced ??= 'eval, which can move the folder out of sight'
  if (name === 'env' && args.some(arg => /^(?:-C|--chdir)/.test(arg.text))) place.unplaced ??= 'env -C, which moves the folder out of sight'
  // bash runs its own cd here, and zsh looks for a program called cd.
  if (name === 'command' && MOVES.has(args[0]?.text ?? '')) place.unplaced ??= 'command cd, which bash and zsh read differently'
  const couldFail = place.chainCanFail
  place.chainCanFail = true
  if (!MOVES.has(name)) return false
  if (connector === '||' || connector === '|' || connector === '|&') place.unplaced ??= 'a cd that may not run'
  if (connector === '&&' && couldFail) place.isGuarded = true
  if (words.slice(0, i).some(word => word.text.startsWith('HOME='))) place.unplaced ??= shellOnly(`${name} with HOME set in front of it`)
  applyMove(place, name, args)
  place.listMoved = true
  place.blocks = place.blocks.map(() => true)
  return true
}

// Walks the text before a commit and says where it leaves the shell.
function followFolder(before: string, start: Place): Place {
  const { tokens, openQuote, inHeredoc } = lex(before)
  const subshells: Place[] = []
  let place = start
  let words: Word[] = []
  let connector: string | undefined
  let lastOp: string | undefined
  for (const token of tokens) {
    if (!('op' in token)) {
      words.push(token)
      lastOp = undefined
      continue
    }
    const { op } = token
    const isEmptyParens = op === ')' && lastOp === '('
    lastOp = op
    const didMove = runCommand(place, words, connector, op)
    words = []
    if ((didMove && (op === '|' || op === '|&')) || (place.listMoved && op === '&')) place.unplaced ??= SUBSHELL_REASON
    if (op === '(') {
      subshells.push({ ...place, vars: new Map(place.vars), blocks: [...place.blocks] })
      place.chainCanFail = false
      place.isGuarded = false
      place.listMoved = false
      connector = undefined
    } else if (op === ')') {
      place = subshells.pop() ?? place
      place.chainCanFail = true
      if (isEmptyParens) place.definesFunction = true
    } else {
      if (place.isGuarded && op !== '&&') place.unplaced ??= 'a cd that may not run'
      if (op !== '&&') place.chainCanFail = false
      if (op !== '&&' && op !== '||' && op !== '|' && op !== '|&') place.listMoved = false
      connector = op
    }
  }
  runCommand(place, words, connector, undefined)
  if (openQuote !== undefined) {
    // The text ends inside a string: a substitution's, or a nested shell's, whose commands
    // count, or just a mention. A substitution runs first, in this shell's folder, whatever
    // the string is for.
    const quote = before.charAt(openQuote)
    const inside = quote === '"' ? scanString(before, openQuote).inside : undefined
    if (inside !== undefined) return followFolder(before.slice(inside), place)
    if (quote === '`' || NESTED_SHELL.test(before.slice(0, openQuote))) {
      // In single quotes the inner shell reads the variables, and it only has exported
      // ones. HOME is already exported, so a new value reaches it.
      if (quote === "'") {
        const home = place.vars.get('HOME')
        place.vars = new Map(home === undefined ? [] : [['HOME', home]])
      }
      return followFolder(before.slice(openQuote + 1), place)
    }
    place.isMention = true
  }
  if (inHeredoc) place.isMention = true
  return place
}

export type CommitTarget = {
  // The folder the commit lands in, relative to where Bash is. Absent: where Bash is.
  dir?: string
  // Why the command's text doesn't say which repo the commit lands in.
  unplaced?: string
}

const withDir = (dir: string | undefined): CommitTarget => (dir === undefined ? {} : { dir })

function targetOf(before: string, gitOptions: string): CommitTarget & { isMention?: boolean } {
  const place = followFolder(before, {
    dir: undefined,
    vars: startingVars(),
    chainCanFail: false,
    isGuarded: false,
    listMoved: false,
    blocks: [],
  })
  if (place.isMention) return { ...withDir(place.dir), isMention: true }
  if (place.unplaced !== undefined) return { unplaced: place.unplaced }
  if (place.definesFunction && place.blocks.length > 0) return { unplaced: FUNCTION_REASON }
  if (/--(?:git-dir|work-tree)\b/.test(gitOptions)) return { unplaced: '--git-dir or --work-tree is on the git command' }

  let { dir } = place
  const words = lex(gitOptions).tokens.filter((token): token is Word => !('op' in token))
  for (let i = 0; i < words.length; i++) {
    const option = words[i]?.text
    if (option !== '-C' && option !== '-c') continue
    i += 1
    const value = words[i]
    if (option === '-c') continue
    const path = value === undefined ? undefined : pathOf(value, place.vars)
    if (path === undefined) return { unplaced: shellOnly(`git -C ${value?.text ?? ''}`.trim()) }
    dir = joinPath(dir, path)
  }
  return withDir(dir)
}

const OPERATOR_CHAR = /[&|;<>]/
const SPLIT_OPERATOR_REASON = 'a line continuation inside an operator, which bash and zsh read differently'

// The shell drops a backslash-newline before it reads anything else, so one can
// sit anywhere, even inside a word: `git com\<newline>mit`. Single quotes join
// here too, because `bash -c '...'` hands that text to a shell that will join it.
// Comments and heredoc bodies keep theirs: a comment ends at the newline whatever
// precedes it, and a body's next line may be its closing tag. A `#` or `<<` inside
// a string can look like one of those, which only leaves that text unjoined.
// `splitsOperator`: one sat inside an operator such as `&&` or `2>`, which bash
// joins and zsh doesn't.
function joinContinuedLines(text: string): { joined: string; splitsOperator: boolean } {
  let out = ''
  let splitsOperator = false
  let heredocs: { tag: string; isTabbed: boolean }[] = []
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    let end = i + 1
    if (c === '\\') {
      // Taken in pairs, so `\\` at a line's end stays an escaped backslash and a newline.
      end = i + 2
    } else if (c === '#' && (out === '' || /[\s;&|()<>`]/.test(out.charAt(out.length - 1)))) {
      const newline = text.indexOf('\n', i)
      end = newline === -1 ? text.length : newline
    } else if (c === '\n' && heredocs.length > 0) {
      const after = afterHeredocs(text, i, heredocs)
      if (after !== -1) end = after
      heredocs = []
    } else if (text.startsWith('<<<', i)) {
      end = i + 3
    } else if (text.startsWith('<<', i)) {
      const opener = /^<<-?[ \t]*/.exec(text.slice(i))?.[0] ?? '<<'
      end = i + opener.length
      const read = readWord(text, end)
      if ('word' in read && read.word.text !== '') heredocs.push({ tag: read.word.text, isTabbed: opener.includes('-') })
    }
    const piece = text.slice(i, end)
    if (piece === '\\\n') {
      const last = out.charAt(out.length - 1)
      const next = text.slice(end).replace(/^(?:\\\n)+/, '').charAt(0)
      if ((OPERATOR_CHAR.test(last) && OPERATOR_CHAR.test(next)) || (/\d/.test(last) && /[<>]/.test(next))) splitsOperator = true
    } else {
      out += piece
    }
    i = end
  }
  return { joined: out, splitsOperator }
}

// Finds a `git commit` in a Bash command and the folder it lands in, following
// `git -C`, `cd`, `pushd`, variables the command sets, subshells, substitutions, if
// blocks and `bash -c` strings. A `--dry-run` commit is no commit. When the text can't
// say (a variable it doesn't set, a cd that may not run, GIT_DIR, a commit in a function,
// commits in two folders) the target is `unplaced`, and the gate refuses it. Text inside a
// string or a heredoc may only mention a commit: it's still gated, and never
// refused for its folder. Reads the command's text, so it still misses a commit
// or a move hidden behind an alias, a variable or a script, or a commit split by
// a line continuation inside a heredoc fed to a shell.
export function findCommit(command: string): CommitTarget | undefined {
  const { joined: text, splitsOperator } = joinContinuedLines(command)
  let found: CommitTarget | undefined
  let mention: CommitTarget | undefined
  for (const match of text.matchAll(GIT_COMMIT)) {
    const start = match.index ?? 0
    const segment = text.slice(start + match[0].length).split(/[;&|\n]/, 1)[0] ?? ''
    if (/(?:^|\s)--dry-run(?=\s|$)/.test(segment)) continue

    // The match opens with the character before `git`, unless it starts the command.
    const before = match[0].startsWith('git') ? '' : text.slice(0, start + 1)
    const { isMention, ...target } = targetOf(before, match[1] ?? '')
    if (isMention) {
      mention ??= target
      continue
    }
    if (splitsOperator) return { unplaced: SPLIT_OPERATOR_REASON }
    if (target.unplaced !== undefined) return target
    if (found !== undefined && found.dir !== target.dir) return { unplaced: 'commits in different folders' }
    found ??= target
  }
  return found ?? mention
}

export type RepoFiles = {
  hasCheckScript: boolean
  packageJson?: string
  lockfiles: readonly string[]
}

// The repo's own check command: scripts/check.sh, else package.json's
// `check` script run by the package manager its lockfile names.
export function detectCommand(files: RepoFiles): string | undefined {
  if (files.hasCheckScript) return 'bash scripts/check.sh'
  if (files.packageJson === undefined) return undefined

  let pkg: unknown
  try {
    pkg = JSON.parse(files.packageJson)
  } catch {
    return undefined
  }
  const scripts = (pkg as { scripts?: Record<string, unknown> } | null)?.scripts
  if (typeof scripts?.check !== 'string') return undefined

  const has = (name: string) => files.lockfiles.includes(name)
  const manager = has('pnpm-lock.yaml')
    ? 'pnpm'
    : has('yarn.lock')
      ? 'yarn'
      : has('bun.lock') || has('bun.lockb')
        ? 'bun'
        : 'npm'
  return `${manager} run check`
}

// The script a package manager runs, whose own banner is not a step.
export function outerScript(command: string): string | undefined {
  return /^(?:npm|pnpm|yarn|bun) run (\S+)$/.exec(command)?.[1]
}

const NOISE = new Set([
  'env', 'uv', 'run', 'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'exec', 'sh', 'bash',
])

// A step's short name: `env X=1 uv run --python 3.13 pytest -q` is `pytest 3.13`.
export function shortLabel(raw: string): string {
  const words = raw.split(/\s+/).filter(Boolean)
  let version: string | undefined
  let name: string | undefined
  for (let i = 0; i < words.length && name === undefined; i++) {
    const word = words[i] ?? ''
    if (word === '--python' && i + 1 < words.length) {
      i += 1
      version = words[i]
    } else if (!/^[A-Za-z_]\w*=/.test(word) && !word.startsWith('-') && !NOISE.has(word)) {
      name = word.replace(/^.*\//, '').replace(/\.(py|sh|ts|js|mjs)$/, '')
    }
  }
  const label = name ?? raw
  return version === undefined ? label : `${label} ${version}`
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const STEP = /^==> (.+?)\s*$/
const FAILED_LIST = /^==> failed:\s*$/
const ALL_PASSED = /^==> all checks passed\s*$/
// `> pkg@1.0.0 test`, or `> test` for a package with no version. npm prints
// a blank line before each banner, never before the command line under it.
const NPM_BANNER = /^> (?:(?:@[^\s/]+\/)?[^\s@/]+@\S+ )?([\w:.-]+)\s*$/

export type Parser = {
  // Takes a piece of output; true when a new step started.
  push: (text: string) => boolean
  finish: () => void
  // With no exit code the run is still going.
  steps: (exitCode?: number) => Step[]
  tail: (lines?: number) => string
}

// Reads a check's output as it streams: `==> <command>` step lines and the
// `==> failed:` list the evals check.sh prints, or npm's `> pkg@1.0.0 <script>`
// banners. Output with neither has no steps, only a pass or a fail.
export function createParser(outer?: string): Parser {
  const raws: string[] = []
  const failed: string[] = []
  let lines: string[] = []
  let partial = ''
  let isInFailedList = false

  const take = (dirty: string) => {
    const line = dirty.slice(dirty.lastIndexOf('\r') + 1).replace(ANSI, '')
    const isAfterBlank = (lines.at(-1) ?? '').trim() === ''
    lines.push(line)
    if (lines.length > 600) lines = lines.slice(-300)

    if (isInFailedList) {
      const listed = /^\s+(\S.*?)\s*$/.exec(line)?.[1]
      if (listed !== undefined) {
        failed.push(listed)
        return
      }
      isInFailedList = false
    }
    if (FAILED_LIST.test(line)) {
      isInFailedList = true
      return
    }
    if (ALL_PASSED.test(line)) return

    const step = STEP.exec(line)?.[1] ?? (isAfterBlank ? NPM_BANNER.exec(line)?.[1] : undefined)
    if (step !== undefined && step !== outer) raws.push(step)
  }

  const statusOf = (raw: string, i: number, exitCode?: number): StepStatus => {
    const last = raws.length - 1
    if (exitCode === undefined) return i < last ? 'done' : 'running'
    if (exitCode === 0) return 'ok'
    if (failed.length > 0) return failed.includes(raw) ? 'failed' : 'ok'
    return i === last ? 'failed' : 'ok'
  }

  return {
    push: text => {
      const before = raws.length
      const parts = (partial + text).split('\n')
      partial = parts.pop() ?? ''
      for (const part of parts) take(part)
      return raws.length !== before
    },
    finish: () => {
      if (partial !== '') take(partial)
      partial = ''
    },
    steps: exitCode =>
      raws.map((raw, i) => ({ label: shortLabel(raw), raw, status: statusOf(raw, i, exitCode) })),
    tail: (count = 60) =>
      lines
        .slice(-count)
        .map(line => (line.length > 400 ? `${line.slice(0, 400)}…` : line))
        .join('\n')
        .trim(),
  }
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

export function failedLabels(run: Run): string[] {
  return run.steps.filter(step => step.status === 'failed').map(step => step.label)
}

const seconds = (run: Run) =>
  run.durationMs === undefined ? '' : ` (${Math.round(run.durationMs / 1000)}s)`

// The band's line for one repo.
export function bandLine(run: Run): string {
  const steps = run.steps.map(step => (step.status === 'running' ? `${step.label}…` : step.label))
  switch (run.status) {
    case 'stale':
      return `· Checks in ${run.repo} haven't run since the last change`
    case 'running': {
      const why = run.trigger === 'commit' ? ' before the commit' : ''
      return `… Checks running in ${run.repo}${why}${steps.length ? `: ${steps.join(' · ')}` : ''}`
    }
    case 'passed':
      return `✓ Checks pass in ${run.repo}${steps.length ? `: ${steps.join(' · ')}` : ''}${seconds(run)}`
    case 'failed': {
      const failed = failedLabels(run)
      return `✗ Checks fail in ${run.repo}${failed.length ? `: ${failed.join(', ')}` : ''}. Commits are blocked.`
    }
    case 'error':
      return `! Couldn't run the checks in ${run.repo}: ${run.reason ?? 'unknown error'}`
  }
}

// What the model reads when the gate stops a commit.
export function denyText(run: Run): string {
  if (run.status === 'error') {
    return [
      `Check gate: this commit was stopped because the checks in ${run.repo} could not run (${run.reason ?? 'unknown error'}).`,
      `Command: ${run.command}`,
      'Tell the user. The check gate mod blocks commits in this repository until its checks run.',
    ].join('\n')
  }
  const failed = failedLabels(run)
  return [
    `Check gate: this commit was stopped because the checks fail in ${run.repo}.`,
    `Command: ${run.command} (exit ${run.exitCode ?? '?'})${failed.length ? `. Failed: ${failed.join(', ')}` : ''}.`,
    'Fix the failures, then commit again. The gate reruns the checks on the next commit attempt once the code has changed.',
    '',
    'Last lines of the output:',
    run.tail || '(no output)',
  ].join('\n')
}

// What the model reads when the gate can't find the commit's repo. `dir` is
// the folder the command named, if any.
export function noRepoText(dir: string | undefined, reason: string): string {
  return [
    "Check gate: this commit was stopped because the gate couldn't tell which git repository it is in.",
    `git rev-parse --show-toplevel in ${dir ?? "the session's folder"} failed: ${reason}`,
    "The gate runs a repository's checks before each commit, so it stops a commit it can't place. If the commit belongs to a repository in another folder, name that folder in the command (git -C /path/to/repo commit ..., or cd /path/to/repo && git commit ...) and run it again. If git itself is failing, tell the user.",
  ].join('\n')
}

// What the model reads when the command's text doesn't say which repo the commit lands in.
export function unplacedText(reason: string): string {
  return [
    `Check gate: this commit was stopped because the gate couldn't tell which git repository it lands in (${reason}).`,
    "The gate runs a repository's checks before each commit, so it stops a commit it can't place. Name the repository's folder plainly and run it again: git -C /path/to/repo commit ..., or cd /path/to/repo && git commit ... If the path has to be worked out, work it out first and put the result in the command.",
  ].join('\n')
}

// What /check-gate log prints.
export function summary(run: Run): string {
  return `${bandLine(run)}\nCommand: ${run.command}${run.exitCode === undefined ? '' : ` (exit ${run.exitCode})`}`
}

// A Run an earlier session stored; anything else is ignored.
export function isRun(value: unknown): value is Run {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.root === 'string' &&
    typeof v.repo === 'string' &&
    typeof v.command === 'string' &&
    typeof v.status === 'string' &&
    typeof v.tree === 'string' &&
    typeof v.tail === 'string' &&
    Array.isArray(v.steps)
  )
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
