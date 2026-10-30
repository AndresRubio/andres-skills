import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'
import {
  FINGERPRINT,
  bandLine,
  basename,
  createParser,
  denyText,
  detectCommand,
  errorText,
  findCommit,
  isRun,
  outerScript,
  summary,
} from './logic'

type Engine = EngineInterface

// Change the tag when Run's fields change: it declines what an earlier
// version stored, which outlives a reload. The store key carries it too.
const runs = atom({ plugin: 'check-gate', key: 'runs' } as const, {}, { shape: 'runs-1' })
const STORE_PREFIX = 'run-1:'
const TEN_MINUTES = 600_000
const COLOR = {
  stale: 'subtle',
  running: 'subtle',
  passed: 'success',
  failed: 'error',
  error: 'warning',
} as const

// Checks running after a turn, one per repo root.
const background = new Map<string, { tree: string; stop: () => void }>()
// Folders of the files edited since the last turn ended.
const touched = new Set<string>()
let host: { shell: string; home: string } | undefined

// The user's shell runs the check (`-ic`, so the PATH from their rc file
// finds uv and npm); zsh, macOS's default, where SHELL is unset.
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

const repoRoot = async ($: Engine, dir?: string) => {
  let cwd = dir
  if (cwd?.startsWith('~/') || cwd === '~') cwd = (await hostInfo($)).home + cwd.slice(1)
  try {
    const found = await $.process.run(['git', 'rev-parse', '--show-toplevel'], cwd ? { cwd } : {})
    return found.exitCode === 0 ? found.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

const commandFor = async ($: Engine, root: string) => {
  const has = (file: string) => $.fs.exists(`${root}/${file}`)
  const hasCheckScript = await has('scripts/check.sh')
  if (hasCheckScript) return detectCommand({ hasCheckScript, lockfiles: [] })
  if (!(await has('package.json'))) return undefined

  const lockfiles: string[] = []
  for (const file of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    if (await has(file)) lockfiles.push(file)
  }
  const packageJson = await $.fs.read(`${root}/package.json`)
  return detectCommand({ hasCheckScript, packageJson, lockfiles })
}

const fingerprint = async ($: Engine, root: string) => {
  const found = await $.process.run(['/bin/sh', '-c', FINGERPRINT], { cwd: root, timeoutMs: 60_000 })
  return found.exitCode === 0 ? found.stdout.trim() || undefined : undefined
}

const stored = async ($: Engine, root: string) => {
  const value = await $.store.get(STORE_PREFIX + root)
  return isRun(value) ? value : undefined
}

const setRun = ($: Engine, run: Run) => update($, runs, all => ({ ...all, [run.root]: run }))

const record = async ($: Engine, run: Run) => {
  await setRun($, run)
  if (run.status === 'passed' || run.status === 'failed') {
    await $.store.set(STORE_PREFIX + run.root, run)
  }
}

// A finished result for this exact command and tree, this session's or an
// earlier one's.
const known = async ($: Engine, root: string, command: string, tree: string) => {
  const candidates = [(await read($, runs))[root], await stored($, root)]
  return candidates.find(
    run =>
      run !== undefined &&
      run.tree === tree &&
      run.command === command &&
      (run.status === 'passed' || run.status === 'failed'),
  )
}

const hasAnyResult = async ($: Engine, root: string) => {
  const row = (await read($, runs))[root]
  return (row !== undefined && row.status !== 'stale') || (await stored($, root)) !== undefined
}

const baseRun = async (root: string, command: string, tree: string, trigger: Run['trigger'], $: Engine): Promise<Run> => ({
  root,
  repo: basename(root),
  command,
  status: 'running',
  trigger,
  steps: [],
  tree,
  startedAt: await $.clock.now(),
  tail: '',
})

const stopBackground = (root: string) => {
  background.get(root)?.stop()
  background.delete(root)
}

// Streams the check in the background, the band following its steps.
const startBackground = async ($: Engine, root: string, command: string, tree: string, trigger: Run['trigger']) => {
  stopBackground(root)
  const { shell } = await hostInfo($)
  const parser = createParser(outerScript(command))
  const base = await baseRun(root, command, tree, trigger, $)
  await setRun($, base)

  const stream = $.process.spawn({ argv: [shell, '-ic', `${command} 2>&1`], cwd: root })
  let isStopped = false
  const job = {
    tree,
    stop: () => {
      isStopped = true
      stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
    },
  }
  background.set(root, job)

  void (async () => {
    let run: Run
    try {
      for await (const chunk of stream) {
        if (parser.push(chunk.text) && !isStopped) await setRun($, { ...base, steps: parser.steps() })
      }
      const { code } = await stream.result
      parser.finish()
      const exitCode = code ?? 1
      run = {
        ...base,
        status: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        steps: parser.steps(exitCode),
        tail: parser.tail(),
        durationMs: (await $.clock.now()) - base.startedAt,
      }
    } catch (error) {
      if (isStopped) return
      run = { ...base, status: 'error', reason: errorText(error), tail: parser.tail() }
    }
    if (isStopped || background.get(root) !== job) return
    background.delete(root)
    await record($, run)
    if (run.status === 'failed') $.ui.toast(bandLine(run))
  })().catch(error => $.ui.log(`check-gate: ${errorText(error)}`, { to: 'debug' }))
}

// `auto` after a turn: reuses a result for the same tree, and leaves a
// repo nobody has checked yet to the Run now button unless this turn
// edited it. `manual` always runs.
const refresh = async ($: Engine, root: string, trigger: Run['trigger'], isEdited = true) => {
  const command = await commandFor($, root)
  if (command === undefined) return
  const tree = await fingerprint($, root)
  if (tree === undefined) return

  if (trigger === 'auto') {
    if (background.get(root)?.tree === tree) return
    const done = await known($, root, command, tree)
    if (done) {
      await setRun($, done)
      return
    }
    if (!isEdited && !(await hasAnyResult($, root))) {
      await setRun($, { ...(await baseRun(root, command, tree, 'auto', $)), status: 'stale' })
      return
    }
  }
  await startBackground($, root, command, tree, trigger)
}

// Runs the check inline, while the commit waits. `$.process.run` time does
// not count against the hook's budget.
const runBeforeCommit = async ($: Engine, root: string, command: string, tree: string) => {
  stopBackground(root)
  const { shell } = await hostInfo($)
  const base = await baseRun(root, command, tree, 'commit', $)
  await setRun($, base)
  $.ui.status(`check gate: running ${command} in ${base.repo} before the commit`)

  let run: Run
  try {
    const ran = await $.process.run([shell, '-ic', `${command} 2>&1`], { cwd: root, timeoutMs: TEN_MINUTES })
    const parser = createParser(outerScript(command))
    parser.push(ran.stdout)
    parser.finish()
    run = {
      ...base,
      status: ran.exitCode === 0 ? 'passed' : 'failed',
      exitCode: ran.exitCode,
      steps: parser.steps(ran.exitCode),
      tail: parser.tail(),
      durationMs: (await $.clock.now()) - base.startedAt,
    }
  } catch (error) {
    run = { ...base, status: 'error', reason: errorText(error) }
  } finally {
    $.ui.status(undefined)
  }
  await record($, run)
  return run
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'check-gate',
      description: 'Run this repo\'s checks now; "/check-gate log" shows the last output',
    })
    // A reload ends the old environment's children: a run left as running is gone.
    await update($, runs, all =>
      Object.fromEntries(Object.entries(all).filter(([, run]) => run.status !== 'running')),
    )
    void (async () => {
      const root = await repoRoot($, await $.session.cwd())
      if (root !== undefined) await refresh($, root, 'auto', false)
    })().catch(error => $.ui.log(`check-gate: ${errorText(error)}`, { to: 'debug' }))
    return started
  })

  on('tool.call', ($, e, next) => {
    const input = e as { tool: string; file_path?: unknown; notebook_path?: unknown }
    const path = input.tool === 'NotebookEdit' ? input.notebook_path : input.file_path
    if ((input.tool === 'Edit' || input.tool === 'Write' || input.tool === 'NotebookEdit') && typeof path === 'string') {
      touched.add(path.replace(/\/[^/]*$/, '') || '/')
    }
    return next(e)
  })

  // The gate. It fails closed: if the gate itself breaks, the commit stops.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (typeof e.command !== 'string') return next(e)
    const commit = findCommit(e.command)
    if (commit === undefined) return next(e)
    const root = await repoRoot($, commit.dir)
    if (root === undefined) return next(e)
    const command = await commandFor($, root)
    if (command === undefined) return next(e)

    const tree = await fingerprint($, root)
    if (tree === undefined) {
      return { deny: `Check gate: couldn't read the working tree of ${basename(root)}, so this commit was stopped. Tell the user.` }
    }
    const run = (await known($, root, command, tree)) ?? (await runBeforeCommit($, root, command, tree))
    if (run.status === 'passed') {
      await setRun($, run)
      return next(e)
    }
    return { deny: denyText(run) }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          deny: `Check gate: the gate itself failed (${next.error?.message ?? 'no reason given'}), so this commit was stopped. Tell the user.`,
        },
  )

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const dirs = [...touched]
    touched.clear()
    void (async () => {
      const edited = new Set<string>()
      for (const dir of dirs) {
        const root = await repoRoot($, dir)
        if (root !== undefined) edited.add(root)
      }
      const cwdRoot = await repoRoot($, await $.session.cwd())
      for (const root of edited) await refresh($, root, 'auto', true)
      if (cwdRoot !== undefined && !edited.has(cwdRoot)) await refresh($, cwdRoot, 'auto', false)
    })().catch(error => $.ui.log(`check-gate: ${errorText(error)}`, { to: 'debug' }))
    return result
  })

  on('command.run', { command: 'check-gate' }, async ($, e) => {
    const all = await read($, runs)
    const root =
      (await repoRoot($, await $.session.cwd())) ??
      Object.values(all).sort((a, b) => b.startedAt - a.startedAt)[0]?.root
    if (root === undefined) return { text: 'Check gate: this folder is not in a git repository.' }

    if (e.args.trim() === 'log') {
      const run = all[root] ?? (await stored($, root))
      return { text: run ? `${summary(run)}\n\n${run.tail || '(no output yet)'}` : `No check has run in ${basename(root)} yet.` }
    }
    const command = await commandFor($, root)
    if (command === undefined) {
      return {
        text: `Check gate: no check command in ${basename(root)}. It looks for scripts/check.sh, then a "check" script in package.json.`,
      }
    }
    void refresh($, root, 'manual').catch(error => $.ui.log(`check-gate: ${errorText(error)}`, { to: 'debug' }))
    return { text: `Check gate: running ${command} in ${basename(root)}. The band above the prompt shows its progress.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const all = Object.values(await read($, runs)).sort((a, b) => a.startedAt - b.startedAt)
    if (all.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {all.slice(-3).map(run => (
          <Box>
            <Text color={COLOR[run.status]} wrap="truncate-end">
              {bandLine(run)}{' '}
            </Text>
            {run.status !== 'running' && (
              <Button
                key={`run:${run.root}`}
                label={run.status === 'stale' ? 'Run now' : 'Run again'}
                onPress={() => refresh($, run.root, 'manual')}
              />
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
