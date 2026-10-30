// Pure matching for digest-guard. Nothing here touches the engine, so the
// tests can lean on it hard.

// ---------------------------------------------------------------------------
// 1. Mailbox identifiers in text headed for site/
// ---------------------------------------------------------------------------

export type Pattern = { name: string; re: RegExp }

// A domain ends where a letter or digit would continue it, so `gmail.company`
// is not Gmail and `jane@gmail.com.` (end of a sentence) still is.
const END = String.raw`(?![A-Za-z0-9])`
// A host starts where a letter, digit or hyphen would continue its label, so
// `webmail.google.com` is not `mail.google.com`, but `.mail.google.com` is.
const host = (name: string) => new RegExp(String.raw`(?:^|[^A-Za-z0-9-])${name}${END}`, 'i')

// The patterns pages.yml and check-structure.py use (mail.google.com,
// outlook.office365.com, outlook.live.com, /owa/?ItemID, @gmail.com), plus
// @googlemail.com. Matching is case-insensitive, which is stricter than both
// of them: an address is the same address in any case. A bare `@gmail.com`
// counts, with no local part in front of it.
export const PATTERNS: readonly Pattern[] = [
  { name: '@gmail.com', re: new RegExp(String.raw`@gmail\.com${END}`, 'i') },
  { name: '@googlemail.com', re: new RegExp(String.raw`@googlemail\.com${END}`, 'i') },
  { name: 'mail.google.com', re: host(String.raw`mail\.google\.com`) },
  { name: 'outlook.office365.com', re: host(String.raw`outlook\.office365\.com`) },
  { name: 'outlook.live.com', re: host(String.raw`outlook\.live\.com`) },
  { name: '/owa/?ItemID', re: /\/owa\/\?ItemID/i },
]

const INVISIBLE = /[­​-‍⁠﻿]/g
const ENTITY = /&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|(commat|period|sol|colon|quest);)/g
const PERCENT = /%([0-9a-fA-F]{2})/g
const NAMED: Record<string, string> = { commat: '@', period: '.', sol: '/', colon: ':', quest: '?' }

const printable = (code: number, original: string) =>
  code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : original

// What a reader or a browser would see: full-width letters folded, invisible
// characters dropped, `%40`, `&#64;` and `&commat;` turned into what they
// stand for. Repeated, so `%2540` gets there too.
export function unmask(line: string): string {
  let text = line.normalize('NFKC').replace(INVISIBLE, '')
  for (let pass = 0; pass < 4; pass++) {
    const next = text
      .replace(ENTITY, (all, dec?: string, hex?: string, name?: string) =>
        name !== undefined
          ? (NAMED[name] ?? all)
          : printable(dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16), all),
      )
      .replace(PERCENT, (all, hex: string) => printable(Number.parseInt(hex, 16), all))
    if (next === text) break
    text = next
  }
  return text
}

// A line that matched, and which patterns matched on it. Never the matched
// text: a refusal must not repeat the address it refuses.
export type Finding = { line: number; patterns: string[] }

export function findIdentifiers(text: string): Finding[] {
  const found: Finding[] = []
  text.split(/\r\n|\n|\r/).forEach((raw, index) => {
    const line = unmask(raw)
    const patterns = PATTERNS.filter(pattern => pattern.re.test(line)).map(pattern => pattern.name)
    if (patterns.length > 0) found.push({ line: index + 1, patterns })
  })
  return found
}

export function describeFindings(findings: readonly Finding[], limit = 6): string {
  const shown = findings.slice(0, limit).map(f => `line ${f.line} (${f.patterns.join(', ')})`)
  const more = findings.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

// Gmail addresses, wherever one slips into text the guard prints back.
export function redact(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@(?:gmail|googlemail)\.com/gi, '[address]')
}

// The text a file-writing tool is about to put on disk, and where. Write
// carries `content`, Edit `new_string`, NotebookEdit `new_source`. What an
// edit removes (`old_string`) is not checked: taking an address out is fine.
export function writtenText(tool: string, input: Record<string, unknown>): string | undefined {
  const value = tool === 'Write' ? input.content : tool === 'Edit' ? input.new_string : input.new_source
  return typeof value === 'string' ? value : undefined
}

export function targetPath(tool: string, input: Record<string, unknown>): string | undefined {
  const value = tool === 'NotebookEdit' ? input.notebook_path : input.file_path
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function writeDenyText(tool: string, rel: string, findings: readonly Finding[]): string {
  return [
    `digest-guard: ${tool} of ${rel} was refused. The text being written carries a Gmail address or mailbox link: ${describeFindings(findings)}.`,
    'Why: ai-digest and its site are public, and no mailbox identifier may reach site/ (the same patterns pages.yml and check-structure.py screen for).',
    'Do: cite the newsletter by name and date as plain text, such as "TLDR AI (Sep 11)", or link the artifact\'s public URL. Then write again without the address or link.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 2. Gmail tools that write
// ---------------------------------------------------------------------------

export const GMAIL_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'send_message',
  'reply',
  'forward',
  'create_draft',
  'update_draft',
  'delete_draft',
  'create_label',
  'update_label',
  'delete_label',
  'label_message',
  'label_thread',
  'unlabel_message',
  'unlabel_thread',
  'update_message_labels',
  'trash_message',
  'trash_thread',
  'untrash_message',
  'untrash_thread',
  'mark_message_spam',
  'mark_thread_spam',
  'unmark_message_spam',
  'unmark_thread_spam',
  'apply_sensitive_message_label',
  'apply_sensitive_thread_label',
])

export const GMAIL_READ_ACTIONS = ['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft']

// `mcp__<server-id>__<action>`: the server id varies per connected account
// and may hold hyphens, so the action is what follows the last `__`. Matched
// by action alone, on any server: a tool of another server that happens to
// share one of these names is refused too while the session is in ai-digest.
export function gmailWriteAction(tool: string): string | undefined {
  const action = /^mcp__.+__([A-Za-z0-9_]+)$/.exec(tool)?.[1]?.toLowerCase()
  return action !== undefined && GMAIL_WRITE_ACTIONS.has(action) ? action : undefined
}

export function gmailDenyText(action: string): string {
  return [
    `digest-guard: Gmail tool ${action} was refused. The ai-digest project never writes to Gmail: no labels, drafts, sending, trashing, spam marks or read-state changes.`,
    `Do: use only ${GMAIL_READ_ACTIONS.join(', ')}. De-duplication is local, in digest-routine/state/processed.json. If this write is really wanted, tell the user: it is a project rule, not a setting.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 3. git push in a Bash command
// ---------------------------------------------------------------------------

// One shell word: plain characters, backslash escapes and quoted runs.
const WORD = String.raw`(?:[^\s"'\\;&|()]|\\.|"[^"]*"|'[^']*')+`
const GIT_OPTION = String.raw`(?:-[Cc]\s+${WORD}|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+${WORD}|--[A-Za-z][\w-]*(?:=${WORD})?|-[A-Za-z]+)`
// `git` after a space, a separator, a quote or a path, so a push inside
// `bash -c "git push"` counts. It also counts inside an echo or a commit
// message: over-matching only runs the gate once more.
const GIT_PUSH = new RegExp(
  String.raw`(?:^|[\s;&|(\x60/"'{])git((?:\s+${GIT_OPTION})*)\s+push(?![\w-])`,
  'g',
)
const GIT_DIR = new RegExp(String.raw`-C\s+(${WORD})`, 'g')
const CD = new RegExp(String.raw`(?:^|[;&|(\n]\s*)cd\s+(${WORD})`, 'g')

export function unquote(word: string): string {
  let out = ''
  for (let i = 0; i < word.length; i++) {
    const c = word.charAt(i)
    if (c === '\\' && i + 1 < word.length) {
      i += 1
      out += word.charAt(i)
    } else if (c === '"' || c === "'") {
      const end = word.indexOf(c, i + 1)
      if (end === -1) return out + word.slice(i + 1)
      out += word.slice(i + 1, end)
      i = end
    } else {
      out += c
    }
  }
  return out
}

// The folders a push runs through, in order: each `cd` before it, then each
// `git -C`. Resolve them with resolveShellDir.
export type PushTarget = { steps: string[] }

// Finds every `git push` in a Bash command. A dry run pushes nothing and is
// skipped. Reads the command's text, so a push hidden behind an alias, a
// variable or a script is not seen.
export function findPushes(command: string): PushTarget[] {
  const found: PushTarget[] = []
  for (const match of command.matchAll(GIT_PUSH)) {
    const start = match.index ?? 0
    const rest = command.slice(start + match[0].length).split(/[;&|\n]/, 1)[0] ?? ''
    if (/(?:^|\s)(?:--dry-run|-n)(?=[\s"')]|$)/.test(rest)) continue

    const steps: string[] = []
    for (const cd of command.slice(0, start + 1).matchAll(CD)) {
      if (cd[1] !== undefined) steps.push(unquote(cd[1]))
    }
    for (const dir of (match[1] ?? '').matchAll(GIT_DIR)) {
      if (dir[1] !== undefined) steps.push(unquote(dir[1]))
    }
    found.push({ steps })
  }
  return found
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!isAbsolute) out.push('..')
    } else {
      out.push(part)
    }
  }
  const joined = out.join('/')
  return isAbsolute ? `/${joined}` : joined === '' ? '.' : joined
}

export function dirname(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

// A path as a tool takes it: `~` is the home folder, a relative path starts
// at the session folder. No other expansion.
export function resolvePath(cwd: string, path: string, home: string): string {
  if (path === '~' || path.startsWith('~/')) return normalizePath(home + path.slice(1))
  return normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`)
}

// A path as the shell takes it, step by step (`cd a && git -C ../b push`).
// `$HOME` and `~` are known; any other expansion, a glob or `cd -` is not,
// and the answer is then undefined.
export function resolveShellDir(cwd: string, steps: readonly string[], home: string): string | undefined {
  let dir = cwd
  for (const raw of steps) {
    const step = raw.replace(/^\$\{HOME\}|^\$HOME(?![\w])/, '~')
    if (step === '-' || /[$\x60*?[\]{}]/.test(step) || /^~[^/]/.test(step)) return undefined
    dir = resolvePath(dir, step, home)
  }
  return dir
}

// A file is under the repo's site/ when the first segment of its path in the
// repo is `site`. Compared without case: the macOS volume is case-insensitive.
export function isUnderSite(rel: string): boolean {
  const parts = normalizePath(rel).split('/')
  return parts.length >= 2 && parts[0]?.toLowerCase() === 'site'
}

export function hasSiteSegment(path: string): boolean {
  return path.split('/').some(part => part.toLowerCase() === 'site')
}

// ---------------------------------------------------------------------------
// The structural gate
// ---------------------------------------------------------------------------

// Run from the repo root, as STEP 5.3 of the routine says. Standard error is
// folded into the output so a Python traceback reaches the refusal.
export const GATE_SCRIPT = 'digest-routine/check-structure.py'
export const GATE_COMMAND = `python3 ${GATE_SCRIPT} 2>&1`

export type Verdict = { ok: true } | { ok: false; reason: string }

// Success is exit 0 and the closing summary with no failures: the script
// prints one line per check, PASS or FAIL (n), then `... N failure(s)`. An
// exit 0 without that line is not taken for a pass (a shim that did nothing).
export function judgeGate(exitCode: number, output: string): Verdict {
  if (exitCode !== 0) return { ok: false, reason: `the gate exited with code ${exitCode}` }
  if (/^\S+\s+FAIL\b/m.test(output)) return { ok: false, reason: 'the gate exited 0 but printed a FAIL line' }
  if (!/(?:^|[\s,])0 failure\(s\)\s*$/m.test(output)) {
    return { ok: false, reason: 'the gate exited 0 but did not print its "0 failure(s)" summary' }
  }
  return { ok: true }
}

export function tailLines(text: string, count = 70): string {
  const lines = text.trim().split('\n')
  const kept = lines.length > count ? ['...', ...lines.slice(-count)] : lines
  return redact(kept.join('\n'))
}

export function pushDenyText(root: string, reason: string, output: string): string {
  return [
    `digest-guard: git push was stopped. The structural gate did not pass in ${basename(root)}: ${reason}.`,
    `Command: ${GATE_COMMAND.replace(' 2>&1', '')}, run from the repo root.`,
    'Fix what it lists, run the gate again until all eleven checks report PASS and it exits 0, then push. The push stays blocked until then.',
    '',
    'Gate output:',
    output === '' ? '(no output)' : tailLines(output),
  ].join('\n')
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
