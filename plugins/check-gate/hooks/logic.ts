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
const GIT_OPTION = String.raw`(?:-[Cc]\s+${WORD}|--[A-Za-z][\w-]*(?:=${WORD})?|-[A-Za-z]+)`
const GIT_COMMIT = new RegExp(
  String.raw`(?:^|[\s;&|(\x60/])git((?:\s+${GIT_OPTION})*)\s+commit(?![\w-])`,
  'g',
)
const GIT_DIR = new RegExp(String.raw`-C\s+(${WORD})`)
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

export type CommitTarget = { dir?: string }

// Finds a `git commit` in a Bash command, and the folder it runs in when the
// command names one (`git -C dir commit`, `cd dir && git commit`). A
// `--dry-run` commit is no commit. Reads the command's text, so it misses a
// commit hidden behind an alias, a variable or a script.
export function findCommit(command: string): CommitTarget | undefined {
  for (const match of command.matchAll(GIT_COMMIT)) {
    const start = match.index ?? 0
    const segment = command.slice(start + match[0].length).split(/[;&|\n]/, 1)[0] ?? ''
    if (/(?:^|\s)--dry-run(?=\s|$)/.test(segment)) continue

    const dir = GIT_DIR.exec(match[1] ?? '')?.[1]
    if (dir !== undefined) return { dir: unquote(dir) }

    let cd: string | undefined
    for (const step of command.slice(0, start + 1).matchAll(CD)) {
      if (step[1] !== undefined) cd = unquote(step[1])
    }
    return cd === undefined ? {} : { dir: cd }
  }
  return undefined
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
