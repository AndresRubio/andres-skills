import type { EngineInterface, Register } from 'claude-code'

import {
  GATE_COMMAND,
  GATE_SCRIPT,
  basename,
  dirname,
  errorText,
  findIdentifiers,
  findPushes,
  gmailDenyText,
  gmailWriteAction,
  hasSiteSegment,
  isUnderSite,
  judgeGate,
  normalizePath,
  pushDenyText,
  resolvePath,
  resolveShellDir,
  targetPath,
  writeDenyText,
  writtenText,
} from './logic'
import type { PushTarget } from './logic'

type Engine = EngineInterface

// What a guard answers with when it says no: the text the model reads, and
// the one line the person sees in a toast.
type Refusal = { deny: string; toast: string }

const GATE_TIMEOUT_MS = 300_000
let host: { shell: string; home: string } | undefined

// The user's shell and home folder, for `~` in a path and for the one case
// where python3 is not on the engine's PATH.
const hostInfo = async ($: Engine) => {
  if (host) return host
  const { stdout } = await $.process.run([
    '/bin/sh',
    '-c',
    's=${SHELL:-}; [ -n "$s" ] || { [ -x /bin/zsh ] && s=/bin/zsh || s=/bin/sh; }; printf "%s\\n%s" "$s" "$HOME"',
  ])
  const [shell, home] = stdout.split('\n')
  host = { shell: shell || '/bin/sh', home: home ?? '' }
  return host
}

// The repo a folder is in: its root, and the folder's path inside it
// (`site/topics/`, empty at the root). A folder outside any repo is
// undefined. Any other git failure throws, so the guard fails closed.
const repoOf = async ($: Engine, dir: string) => {
  const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--show-prefix'], { cwd: dir })
  if (ran.exitCode !== 0) {
    if (/not a git repository/i.test(ran.stderr)) return undefined
    throw new Error(`git rev-parse failed in ${dir}: ${ran.stderr.trim().slice(0, 200)}`)
  }
  const [root = '', prefix = ''] = ran.stdout.split('\n')
  return root.trim() === '' ? undefined : { root: root.trim(), prefix: prefix.trim() }
}

// ai-digest: a repo whose root folder is named so, or that has the gate
// script no other repo has.
const isAiDigest = async ($: Engine, root: string) =>
  basename(root) === 'ai-digest' || (await $.fs.exists(`${root}/${GATE_SCRIPT}`))

const refuse = ($: Engine, refusal: Refusal) => {
  try {
    $.ui.toast(refusal.toast)
  } catch {
    // The refusal stands without its toast.
  }
  return { deny: refusal.deny }
}

// The path of `abs` inside the ai-digest repo it belongs to, when that is
// under site/. A file not there yet is judged by its nearest folder that is.
const siteTarget = async ($: Engine, abs: string) => {
  const tail = [basename(abs)]
  let probe = dirname(abs)
  while (probe !== '/' && !(await $.fs.exists(probe))) {
    tail.unshift(basename(probe))
    probe = dirname(probe)
  }
  const repo = await repoOf($, probe)
  if (repo === undefined || !(await isAiDigest($, repo.root))) return undefined
  const rel = normalizePath(repo.prefix + tail.join('/'))
  return isUnderSite(rel) ? rel : undefined
}

// Write, Edit and NotebookEdit. A text with no identifier costs nothing: no
// call to the engine is made.
const checkWrite = async ($: Engine, tool: string, input: Record<string, unknown>): Promise<Refusal | undefined> => {
  const text = writtenText(tool, input)
  const path = targetPath(tool, input)
  if (text === undefined || path === undefined) return undefined
  const findings = findIdentifiers(text)
  if (findings.length === 0) return undefined

  const home = path.startsWith('~') ? (await hostInfo($)).home : ''
  const cwd = path.startsWith('/') ? '/' : await $.session.cwd()
  const abs = resolvePath(cwd, path, home)
  // A symbolic link outside site/ may lead into it.
  const stat = await $.fs.stat(abs, { resolve: true }).catch(() => undefined)
  const candidates = stat?.realPath !== undefined && stat.realPath !== abs ? [abs, stat.realPath] : [abs]

  for (const candidate of candidates) {
    if (!hasSiteSegment(candidate)) continue
    const rel = await siteTarget($, candidate)
    if (rel !== undefined) {
      return {
        deny: writeDenyText(tool, rel, findings),
        toast: `digest-guard: ${tool} of ${rel} refused, it has a Gmail address or mailbox link`,
      }
    }
  }
  return undefined
}

// A Gmail write, judged by the repo the session runs in.
const checkGmail = async ($: Engine, action: string): Promise<Refusal | undefined> => {
  const repo = await repoOf($, await $.session.cwd())
  if (repo === undefined || !(await isAiDigest($, repo.root))) return undefined
  return {
    deny: gmailDenyText(action),
    toast: `digest-guard: Gmail ${action} refused, ai-digest never writes to Gmail`,
  }
}

// The gate as the routine runs it: python3 on the script, from the repo root.
// A shell that cannot find python3 (127) is tried once more as the user's own.
const runGate = async ($: Engine, root: string) => {
  const options = { cwd: root, timeoutMs: GATE_TIMEOUT_MS }
  const first = await $.process.run(['/bin/sh', '-c', GATE_COMMAND], options)
  if (first.exitCode !== 127) return first
  const { shell } = await hostInfo($)
  return $.process.run([shell, '-ic', GATE_COMMAND], options)
}

// One push. `seen` holds the roots this command already passed.
const checkPush = async ($: Engine, target: PushTarget, seen: Set<string>): Promise<Refusal | undefined> => {
  const cwd = await $.session.cwd()
  // A folder the command names through a variable is unknown: use the session's.
  const dir = resolveShellDir(cwd, target.steps, (await hostInfo($)).home) ?? cwd
  if (!(await $.fs.exists(dir))) return undefined
  const repo = await repoOf($, dir)
  if (repo === undefined || seen.has(repo.root) || !(await isAiDigest($, repo.root))) return undefined
  seen.add(repo.root)

  const stopped = (reason: string, output: string): Refusal => ({
    deny: pushDenyText(repo.root, reason, output),
    toast: `digest-guard: git push stopped, the structural gate did not pass in ${basename(repo.root)}`,
  })
  if (!(await $.fs.exists(`${repo.root}/${GATE_SCRIPT}`))) {
    return stopped(`${GATE_SCRIPT} is missing, so the push cannot be checked`, '')
  }
  let ran
  try {
    ran = await runGate($, repo.root)
  } catch (error) {
    return stopped(`the gate could not run (${errorText(error)})`, '')
  }
  const verdict = judgeGate(ran.exitCode, ran.stdout)
  return verdict.ok ? undefined : stopped(verdict.reason, ran.stdout)
}

export const register: Register = on => {
  // 1. Nothing under site/ may carry a Gmail address or a mailbox link.
  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const refusal = await checkWrite($, e.tool, e as unknown as Record<string, unknown>)
    return refusal ? refuse($, refusal) : next(e)
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          deny: `digest-guard: the site/ guard failed (${next.error?.message ?? 'no reason given'}), so this ${e.tool} was refused. Tell the user.`,
        },
  )

  // 2. No Gmail tool that writes.
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    const action = gmailWriteAction(e.tool)
    if (action === undefined) return next(e)
    const refusal = await checkGmail($, action)
    return refusal ? refuse($, refusal) : next(e)
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          deny: `digest-guard: the Gmail guard failed (${next.error?.message ?? 'no reason given'}), so ${e.tool} was refused. Tell the user.`,
        },
  )

  // 3. The structural gate before a push.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (typeof e.command !== 'string') return next(e)
    const pushes = findPushes(e.command)
    if (pushes.length === 0) return next(e)
    const seen = new Set<string>()
    for (const push of pushes) {
      const refusal = await checkPush($, push, seen)
      if (refusal) return refuse($, refusal)
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          deny: `digest-guard: the push guard failed (${next.error?.message ?? 'no reason given'}), so this command was refused. Tell the user.`,
        },
  )
}
