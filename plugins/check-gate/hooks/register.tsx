import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'
import {
  FINGERPRINT,
  GRACE_MS,
  bandLine,
  basename,
  createParser,
  denyText,
  detectCommand,
  errorText,
  findCommit,
  isRun,
  noRepoText,
  outerScript,
  pendingText,
  movedText,
  reportText,
  restartedText,
  summary,
  unplacedText,
} from './logic'

type Engine = EngineInterface

// Change the tag when Run's fields change: it declines what an earlier
// version stored, which outlives a reload. The store key carries it too.
const runs = atom({ plugin: 'check-gate', key: 'runs' } as const, {}, { shape: 'runs-1' })
const STORE_PREFIX = 'run-1:'
const COLOR = {
  stale: 'subtle',
  running: 'subtle',
  passed: 'success',
  failed: 'error',
  error: 'warning',
} as const

// A check running in the background. `owed`: a commit was refused while this
// run goes on, so its end is reported to the model. `ended` resolves when the
// run's result is stored, and never for a run that was stopped.
type Job = { tree: string; owed: boolean; ended: Promise<void>; stop: () => void }

// One per repo root.
const background = new Map<string, Job>()
// Per repo root, the commits of the main conversation inside the gate's wait
// right now. Each reads the result itself, so a run that ends while one is
// there sends no report. The count is the root's and not the run's, since the
// run may be started over during the wait. A subagent's commit is not
// counted: the report is a message to the main conversation, which a
// subagent reading the result does not replace.
const reading = new Map<string, number>()
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

// The repo's top folder as git reports it, or why git couldn't say.
const locateRepo = async ($: Engine, dir?: string): Promise<{ root: string } | { reason: string }> => {
  let cwd = dir
  if (cwd?.startsWith('~/') || cwd === '~') cwd = (await hostInfo($)).home + cwd.slice(1)
  try {
    const found = await $.process.run(['git', 'rev-parse', '--show-toplevel'], cwd ? { cwd } : {})
    const root = found.exitCode === 0 ? found.stdout.trim() : ''
    if (root) return { root }
    return { reason: found.stderr.trim() || `exit ${found.exitCode} with no path` }
  } catch (error) {
    return { reason: errorText(error) }
  }
}

const repoRoot = async ($: Engine, dir?: string) => {
  const found = await locateRepo($, dir)
  return 'root' in found ? found.root : undefined
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

const unreadText = (root: string) =>
  `Check gate: couldn't read the working tree of ${basename(root)}, so this commit was stopped. Tell the user.`

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

// A run a commit was refused on reports back when it ends, as a prompt of the
// plugin's that takes a turn of its own once the session is idle, so the model
// learns the outcome without polling. A prompt the engine drops is toasted
// instead, so the person sees what the model is waiting for.
const tellSession = async ($: Engine, run: Run) => {
  const text = reportText(run)
  const entered = await $.prompt.submit({ text })
  if (entered.drop !== undefined) {
    $.ui.toast(text)
    $.ui.log(`check-gate: the report was dropped: ${entered.drop}`, { to: 'debug' })
  }
}

// Streams the check in the background, the band following its steps. Returns
// the run as it starts and the job that follows it. A run replaced while a
// report was owed owes it too: the model is waiting on this root's next
// result, whichever run gives it.
const startBackground = async ($: Engine, root: string, command: string, tree: string, trigger: Run['trigger']) => {
  const owed = background.get(root)?.owed ?? false
  stopBackground(root)
  const { shell } = await hostInfo($)
  const parser = createParser(outerScript(command))
  const base = await baseRun(root, command, tree, trigger, $)
  await setRun($, base)

  const stream = $.process.spawn({ argv: [shell, '-ic', `${command} 2>&1`], cwd: root })
  let isStopped = false
  let settle: () => void = () => undefined
  const ended = new Promise<void>(resolve => {
    settle = resolve
  })
  const job: Job = {
    tree,
    owed,
    ended,
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
    // A result that could not be stored still ends the run: the job leaves the
    // map below, and the next commit starts the checks again.
    await record($, run).catch(error =>
      $.ui.log(`check-gate: the result was not stored: ${errorText(error)}`, { to: 'debug' }),
    )
    // A run replaced while its result was stored leaves the report to its
    // replacement, which took the flag over.
    if (isStopped || background.get(root) !== job) return
    // The job leaves the map in the step that reads `owed`, with the result
    // already stored: a commit whose wait ran out either still finds the job
    // and sets the flag in time, or finds the result.
    background.delete(root)
    settle()
    if (run.status === 'failed') $.ui.toast(bandLine(run))
    if (job.owed && (reading.get(root) ?? 0) === 0) await tellSession($, run)
  })().catch(error => $.ui.log(`check-gate: ${errorText(error)}`, { to: 'debug' }))
  return { run: base, job }
}

// Waits for the run to end, for as long as the gate allows. A wait the
// engine refuses counts as one that ran out, and so does one the hook's own
// dispatch ends, as an interrupt does.
const endOrGrace = async ($: Engine, job: Job, dispatch: AbortSignal) => {
  const wait = new AbortController()
  const stop = () => wait.abort()
  if (dispatch.aborted) stop()
  dispatch.addEventListener('abort', stop, { once: true })
  const waited = $.clock.sleep(GRACE_MS, { signal: wait.signal }).catch(() => undefined)
  await Promise.race([job.ended, waited])
  // Ends a wait the run beat, so no timer outlives the call.
  dispatch.removeEventListener('abort', stop)
  stop()
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

  // The gate. It fails closed: if the command's text doesn't settle the
  // commit's repo, git can't find it, or the gate itself breaks, the commit
  // stops. That includes a folder outside any repo: the command may move
  // somewhere the gate can't read, so "not a repo here" doesn't prove git
  // would refuse the commit.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (typeof e.command !== 'string') return next(e)
    const commit = findCommit(e.command)
    if (commit === undefined) return next(e)
    if (commit.unplaced !== undefined) return { deny: unplacedText(commit.unplaced) }
    // A bare `git commit` lands in the Bash tool's folder. `$.session.cwd()`
    // follows Bash's `cd` (`$.session.root()` doesn't), and so does
    // process.run's default on 2.1.309. Naming the folder keeps the gate off
    // that default.
    const found = await locateRepo($, commit.dir ?? (await $.session.cwd()))
    if (!('root' in found)) return { deny: noRepoText(commit.dir, found.reason) }
    const { root } = found
    const command = await commandFor($, root)
    if (command === undefined) return next(e)

    const tree = await fingerprint($, root)
    if (tree === undefined) return { deny: unreadText(root) }
    const done = await known($, root, command, tree)
    if (done?.status === 'passed') {
      await setRun($, done)
      return next(e)
    }
    if (done) return { deny: denyText(done) }
    // No result for this tree: the checks run in the background and the
    // commit waits a few seconds for them. A check that ends within that wait,
    // as a script that remembers the trees it passed does, settles the commit
    // in this call. A longer run is refused and reports back when it ends:
    // waiting on it inside the tool call would let the call's timeout end the
    // run and the commit together.
    const going = (await read($, runs))[root]
    const current = background.get(root)
    const isNew = current === undefined || current.tree !== tree || going?.status !== 'running'
    const { run, job } =
      isNew || going === undefined ? await startBackground($, root, command, tree, 'commit') : { run: going, job: current }
    const isMain = e.agentId === undefined
    if (isMain) reading.set(root, (reading.get(root) ?? 0) + 1)
    try {
      await endOrGrace($, job, next.signal)
      // Everything is read again after the wait. The tree first: a result for
      // the tree as it was says nothing about files that changed since.
      const after = await fingerprint($, root)
      if (after === undefined) return { deny: unreadText(root) }
      if (after !== tree) return { deny: movedText(run) }
      const ended = await known($, root, command, tree)
      if (ended?.status === 'passed') return next(e)
      if (ended) return { deny: denyText(ended) }
      const row = (await read($, runs))[root]
      if (row?.status === 'error' && row.tree === tree) return { deny: denyText(row) }
      // Still running, this run or one that replaced it: that one owes the
      // report. With none in the map, a run ended or started over while the
      // lines above read, so the commit is asked for again and nothing is
      // promised.
      const owing = background.get(root)
      if (owing === undefined) return { deny: restartedText(run) }
      owing.owed = true
      return { deny: pendingText(run, isNew) }
    } finally {
      if (isMain) reading.set(root, (reading.get(root) ?? 1) - 1)
    }
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
