import { describe, expect, test } from 'claude-code/testing'

import {
  BUILTIN_MODAL_PRICES,
  applySets,
  askText,
  asReminders,
  cleanupClears,
  findForja,
  formatDuration,
  isGuarded,
  isPromptAborted,
  isRunFolder,
  joinPath,
  judgeRun,
  leftoverNote,
  parseCleanup,
  parseExitMarker,
  parseExitText,
  parseOutputPath,
  parsePricing,
  parseQuote,
  parseRunArgs,
  parseRunFolder,
  parseState,
  parseYaml,
  planFor,
  readBashResult,
  reminderLine,
  runLine,
  runSettings,
  runsNeedingConfirmation,
  worstCaseUsd,
} from '../hooks/logic'
import {
  cleanupClean,
  cleanupDeleted,
  cleanupNone,
  cleanupPromptEof,
  cleanupProvider,
  cleanupUnconfirmed,
  destroyUnconfirmed,
  firstCtrlC,
  forcedExit,
  forcedState,
  jobFailed,
  keepOnFailure,
  modalA100,
  orphansWarning,
  pricingPy,
  promptEof,
  smokeYaml,
  success,
  successState,
} from './fixtures'

// What the Bash tool returned in this session, copied as it came.
const BACKGROUND_TEXT =
  'Command running in background with ID: bjxvgg5s8. Output is being written to: /private/tmp/claude-501/x/tasks/bjxvgg5s8.output. You will be notified when it completes — do not poll that file or sleep while waiting.'
const BACKGROUND_FILE = 'background-done\n\n[exited with code 3]\n'
const FAILED_TEXT = 'Exit code 3\nout-line\nerr-line'

describe('findForja', () => {
  test('finds forja run however it is launched', async () => {
    expect(findForja('forja run cfg.yaml --yes')).toEqual([{ sub: 'run', args: ['cfg.yaml', '--yes'], cds: [], isStdinFed: false }])
    expect(findForja('uv run forja run recipes/smoke/smoke.yaml --yes')[0]?.args).toEqual(['recipes/smoke/smoke.yaml', '--yes'])
    expect(findForja('uv run --project /repo forja run x.yaml')[0]?.sub).toBe('run')
    expect(findForja('.venv/bin/forja run x.yaml')[0]?.sub).toBe('run')
    expect(findForja('HF_TOKEN=abc caffeinate -i forja run x.yaml --yes')[0]?.sub).toBe('run')
    expect(findForja('bash -lc "uv run forja run x.yaml --yes"')[0]?.args).toEqual(['x.yaml', '--yes'])
    expect(findForja('out=$(forja run x.yaml --yes)')[0]?.sub).toBe('run')
    expect(findForja('eval "forja run x.yaml --yes"')[0]?.sub).toBe('run')
  })

  test('follows cd and sees a fed stdin', async () => {
    expect(findForja('cd recipes/smoke && forja run smoke.yaml --yes')[0]?.cds).toEqual(['recipes/smoke'])
    expect(findForja('echo y | forja run x.yaml')[0]?.isStdinFed).toBe(true)
    expect(findForja('yes | uv run forja run x.yaml')[0]?.isStdinFed).toBe(true)
    expect(findForja('forja run x.yaml < answers.txt')[0]?.isStdinFed).toBe(true)
    expect(findForja("forja run x.yaml <<< 'y'")[0]?.isStdinFed).toBe(true)
    expect(findForja('forja run x.yaml < /dev/null')[0]?.isStdinFed).toBe(false)
    expect(findForja('forja run x.yaml 2>&1 | tee log.txt')[0]).toEqual({ sub: 'run', args: ['x.yaml'], cds: [], isStdinFed: false })
  })

  test('reads cleanup and leaves other commands alone', async () => {
    expect(findForja('forja cleanup --provider modal --yes')[0]).toEqual({
      sub: 'cleanup',
      args: ['--provider', 'modal', '--yes'],
      cds: [],
      isStdinFed: false,
    })
    expect(findForja('grep forja run.log')).toEqual([])
    expect(findForja('echo "forja run x --yes"')).toEqual([])
    expect(findForja('git commit -m "forja run --yes"')).toEqual([])
    expect(findForja('ls -la')).toEqual([])
  })
})

describe('parseRunArgs and runsNeedingConfirmation', () => {
  test('reads options anywhere, with values', async () => {
    expect(parseRunArgs(['--set', 'train.runner.provider=runpod', 'smoke.yaml', '--yes', '--set=a=1', '--out', 'r'])).toEqual({
      config: 'smoke.yaml',
      sets: ['train.runner.provider=runpod', 'a=1'],
      isYes: true,
      out: 'r',
      isKeepOnFailure: false,
      isHelp: false,
    })
    expect(parseRunArgs(['--help']).isHelp).toBe(true)
  })

  test('asks about --yes and a fed stdin, never a plain run', async () => {
    expect(runsNeedingConfirmation('uv run forja run recipes/smoke/smoke.yaml --yes').runs).toHaveLength(1)
    expect(runsNeedingConfirmation('echo y | forja run smoke.yaml').runs).toHaveLength(1)
    expect(runsNeedingConfirmation('forja run smoke.yaml')).toEqual({ runs: [], isUnparsed: false })
    expect(runsNeedingConfirmation('forja run --help')).toEqual({ runs: [], isUnparsed: false })
    expect(runsNeedingConfirmation('forja validate smoke.yaml')).toEqual({ runs: [], isUnparsed: false })
    expect(runsNeedingConfirmation('echo forja run x --yes')).toEqual({ runs: [], isUnparsed: false })
  })

  test('a forja run it cannot place is still asked about', async () => {
    expect(runsNeedingConfirmation('ls cfgs/*.yaml | xargs -n1 forja run --yes').isUnparsed).toBe(true)
    expect(isGuarded({ command: 'ls | xargs -n1 forja run --yes' })).toBe(true)
    expect(isGuarded({ command: 'forja run x.yaml' })).toBe(false)
    expect(isGuarded({ file_path: 'x' })).toBe(false)
  })
})

describe('the config', () => {
  test('reads recipes/smoke/smoke.yaml', async () => {
    const raw = parseYaml(smokeYaml)
    expect(raw.project).toBe('smoke')
    expect(raw.train).toEqual({ runner: { provider: 'modal', gpu: 'L4', max_hours: 1 } })
    expect(raw.export).toEqual({ gguf: ['Q8_0', 'Q4_K_M'] })
    expect((raw.checks as Record<string, unknown>).expect_regex).toBe('^\\{"answer": -?\\d+\\}$')
    expect(runSettings(raw)).toEqual({ project: 'smoke', provider: 'modal', gpus: ['L4'], maxHours: 1 })
  })

  test('reads block lists, comments and forja defaults', async () => {
    const raw = parseYaml(
      ['project: demo # name', 'train:', '  runner:', '    provider: runpod', '    gpu:', '    - "NVIDIA L4"', '    - NVIDIA GeForce RTX 4090', '    max_hours: 2.5'].join('\n'),
    )
    expect(runSettings(raw)).toEqual({ project: 'demo', provider: 'runpod', gpus: ['NVIDIA L4', 'NVIDIA GeForce RTX 4090'], maxHours: 2.5 })
    expect(runSettings(parseYaml('train:\n  runner:\n    provider: modal\n'))).toEqual({ project: undefined, provider: 'modal', gpus: ['L4'], maxHours: 1 })
  })

  test('applies --set overrides as the guide writes them', async () => {
    const raw = applySets(parseYaml(smokeYaml), ['train.runner.provider=runpod', 'train.runner.gpu=["NVIDIA L4", "NVIDIA GeForce RTX 4090"]'])
    expect(runSettings(raw).provider).toBe('runpod')
    expect(runSettings(raw).gpus).toEqual(['NVIDIA L4', 'NVIDIA GeForce RTX 4090'])
    expect(runSettings(applySets(parseYaml(smokeYaml), ['train.runner.max_hours=30'])).maxHours).toBeUndefined()
  })
})

describe('prices', () => {
  test('reads forja pricing.py and matches the built-in copy', async () => {
    expect(parsePricing(pricingPy)).toEqual(BUILTIN_MODAL_PRICES)
  })

  test('rounds the worst case up to a cent, like worst_case_usd', async () => {
    expect(worstCaseUsd(0.8, 1)).toBe(0.8)
    expect(worstCaseUsd(2.5, 2.5)).toBe(6.25)
    expect(worstCaseUsd(0.59, 1.5)).toBe(0.89)
  })

  test('a Modal plan gives what forja itself prints', async () => {
    const plan = planFor('recipes/smoke/smoke.yaml', parseYaml(smokeYaml), BUILTIN_MODAL_PRICES)
    expect(plan.quote).toEqual({ ...parseQuote(promptEof.output), source: 'table' })
    const bigger = planFor('x', applySets(parseYaml(smokeYaml), ['train.runner.gpu=A100-80GB', 'train.runner.max_hours=2.5']), BUILTIN_MODAL_PRICES)
    expect(bigger.quote).toEqual({ ...parseQuote(modalA100.output), source: 'table' })
  })

  test('RunPod and unknown GPUs say why the price is not shown', async () => {
    const runpod = planFor('x.yaml', applySets(parseYaml(smokeYaml), ['train.runner.provider=runpod']), BUILTIN_MODAL_PRICES)
    expect(runpod.quote).toBeUndefined()
    expect(runpod.problem).toContain('RunPod gives the price when forja starts')
    expect(askText([runpod], false)).toContain('run the command once without --yes')
    const typo = planFor('x.yaml', applySets(parseYaml(smokeYaml), ['train.runner.gpu=L5']), BUILTIN_MODAL_PRICES)
    expect(typo.problem).toContain('L5 is not a Modal GPU id')
  })

  test('a quote forja printed for the config wins', async () => {
    const seen = { provider: 'runpod', gpu: 'NVIDIA L4', hourlyUsd: 0.44, worstUsd: 0.44, maxHours: 1, note: 'RunPod Secure Cloud', source: 'forja' as const }
    const plan = planFor('x.yaml', applySets(parseYaml(smokeYaml), ['train.runner.provider=runpod']), BUILTIN_MODAL_PRICES, seen)
    expect(plan.quote).toEqual(seen)
  })

  test('the question names the config, GPU, price and maximum cost', async () => {
    const plan = planFor('recipes/smoke/smoke.yaml', parseYaml(smokeYaml), BUILTIN_MODAL_PRICES)
    const text = askText([plan], false)
    expect(text).toContain('Config recipes/smoke/smoke.yaml: modal L4 at $0.80/h (Modal list price as of 2026-10-05, GPU only); maximum cost $0.80 for max_hours=1.')
    expect(text).toContain('the person must approve this call')
  })
})

describe('forja output', () => {
  test('reads the cost line and the aborted question', async () => {
    expect(parseQuote(promptEof.output)).toEqual({
      provider: 'modal',
      gpu: 'L4',
      hourlyUsd: 0.8,
      note: 'Modal list price as of 2026-10-05, GPU only',
      worstUsd: 0.8,
      maxHours: 1,
      source: 'forja',
    })
    expect(isPromptAborted(promptEof.output)).toBe(true)
    expect(isPromptAborted(orphansWarning.output)).toBe(true)
    expect(isPromptAborted(success.output)).toBe(false)
  })

  test('tells which endings may leave remote resources', async () => {
    const judge = (f: { output: string; exitCode: number }, state?: string) =>
      judgeRun({ exitCode: f.exitCode, isInterrupted: false, output: f.output, state: state === undefined ? undefined : parseState(state), couldLook: true })
    expect(judge(success, successState)).toBeUndefined()
    expect(judge(jobFailed)).toBeUndefined()
    expect(judge(promptEof)).toBeUndefined()
    expect(judge(firstCtrlC)).toBeUndefined()
    expect(judge(destroyUnconfirmed)).toEqual({ kind: 'unconfirmed', provider: 'modal' })
    expect(judge(keepOnFailure)).toEqual({ kind: 'kept', provider: 'modal' })
    expect(judge(forcedExit, forcedState)).toEqual({ kind: 'forced', provider: 'modal' })
    expect(judge(orphansWarning)).toEqual({ kind: 'warning', provider: 'modal' })
    expect(judge({ exitCode: 3, output: '' })).toEqual({ kind: 'exit-3', provider: undefined })
  })

  test('an interrupted run counts once its run folder exists', async () => {
    const cut = (state: string | undefined, couldLook = true) =>
      judgeRun({ isInterrupted: true, output: '', state: state === undefined ? undefined : parseState(state), couldLook })
    expect(cut(forcedState)).toEqual({ kind: 'interrupted', provider: 'modal' })
    expect(cut(undefined)).toBeUndefined()
    expect(cut(undefined, false)).toEqual({ kind: 'interrupted', provider: undefined })
    expect(cut(successState)).toBeUndefined()
    expect(judgeRun({ exitCode: 143, isInterrupted: false, output: 'creating remote resources on modal; this can take a few minutes\n', couldLook: true })?.kind).toBe(
      'interrupted',
    )
  })

  test('reads state.json and the run folder line', async () => {
    expect(parseState(successState)).toEqual({
      provider: 'modal',
      remoteName: 'forja-989f8985',
      status: 'destroyed',
      createdAt: Date.parse('2026-10-30T06:34:43+00:00'),
      gpuSeconds: 0,
      estCostUsd: 0,
      destroyConfirmed: true,
    })
    expect(parseState(forcedState)?.gpuSeconds).toBeUndefined()
    expect(parseState('not json')).toBeUndefined()
    expect(parseRunFolder(destroyUnconfirmed.output)).toEqual({ runDir: '/repo/recipes/smoke/runs/2026-10-30_smoke_r1', status: 'verified', exitCode: 3 })
    expect(isRunFolder('2026-10-30_smoke_r12', 'smoke')).toBe(true)
    expect(isRunFolder('2026-10-30_smokey_r1', 'smoke')).toBe(false)
  })
})

describe('Bash tool results', () => {
  test('reads exit codes, background tasks and refusals', async () => {
    expect(parseExitText(FAILED_TEXT)).toEqual({ exitCode: 3, output: 'out-line\nerr-line' })
    expect(parseOutputPath(BACKGROUND_TEXT)).toBe('/private/tmp/claude-501/x/tasks/bjxvgg5s8.output')
    expect(parseExitMarker(BACKGROUND_FILE)).toEqual({ exitCode: 3, output: 'background-done\n' })
    expect(parseExitMarker('still going\n')).toBeUndefined()

    expect(readBashResult({ isError: true, text: FAILED_TEXT, result: FAILED_TEXT })).toEqual({
      kind: 'done',
      exitCode: 3,
      isInterrupted: false,
      output: 'out-line\nerr-line',
    })
    expect(readBashResult({ text: BACKGROUND_TEXT, result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bjxvgg5s8' } })).toEqual({
      kind: 'background',
      outputPath: '/private/tmp/claude-501/x/tasks/bjxvgg5s8.output',
    })
    expect(readBashResult({ text: 'ok', result: { stdout: 'ok', stderr: '', interrupted: false } })).toEqual({ kind: 'done', exitCode: 0, isInterrupted: false, output: 'ok' })
    expect(readBashResult({ deny: 'no' })).toEqual({ kind: 'refused' })
    expect(readBashResult({ isError: true, text: 'The user rejected this tool use' })).toEqual({ kind: 'refused' })
  })
})

describe('forja cleanup', () => {
  test('tells per provider what is clean', async () => {
    expect(parseCleanup(cleanupDeleted.output)).toEqual({ providers: { modal: 'clean', runpod: 'skipped' }, isInterrupted: false })
    expect(parseCleanup(cleanupClean.output).providers).toEqual({ modal: 'clean', runpod: 'skipped' })
    expect(parseCleanup(cleanupProvider.output).providers).toEqual({ modal: 'clean' })
    expect(parseCleanup(cleanupUnconfirmed.output).providers).toEqual({ modal: 'left', runpod: 'left' })
    expect(parseCleanup(cleanupPromptEof.output)).toEqual({ providers: { modal: 'left' }, isInterrupted: true })
    expect(parseCleanup(cleanupNone.output).providers).toEqual({ modal: 'skipped', runpod: 'skipped' })
  })

  test('clears a reminder only for a provider it shows clean', async () => {
    const clears = (f: { output: string; exitCode: number }, key: string) => cleanupClears(parseCleanup(f.output), f.exitCode, key)
    expect(clears(cleanupDeleted, 'modal')).toBe(true)
    expect(clears(cleanupDeleted, 'runpod')).toBe(false)
    expect(clears(cleanupDeleted, 'unknown')).toBe(false)
    expect(clears(cleanupProvider, 'unknown')).toBe(true)
    expect(clears(cleanupUnconfirmed, 'modal')).toBe(false)
    expect(clears(cleanupPromptEof, 'modal')).toBe(false)
    expect(clears(cleanupNone, 'modal')).toBe(false)
  })
})

describe('text', () => {
  test('the band line shows time, price, cost so far and the maximum', async () => {
    const run = {
      id: 't1',
      config: 'recipes/smoke/smoke.yaml',
      cwd: '/repo',
      provider: 'modal',
      gpu: 'L4',
      hourlyUsd: 0.8,
      worstUsd: 0.8,
      maxHours: 1,
      known: [],
      startedAt: 0,
      status: 'running',
    }
    expect(runLine(run, 30 * 60_000 + 5_000)).toBe('forja run smoke.yaml: modal L4 · 30m 05s elapsed · $0.80/h · $0.40 so far · max $0.80')
    expect(runLine({ ...run, hourlyUsd: undefined, provider: 'runpod', gpu: 'NVIDIA L4', status: 'launched' }, 45_000)).toBe(
      'forja run smoke.yaml: runpod NVIDIA L4 · 45s elapsed · price not known yet · max_hours=1 · launched',
    )
    expect(formatDuration(3_725_000)).toBe('1h 02m')
  })

  test('the reminder and the note name the cleanup command', async () => {
    expect(reminderLine({ key: 'modal', provider: 'modal', why: 'forja could not confirm the delete', since: 0 })).toBe(
      'Remote forja resources may still exist on modal (forja could not confirm the delete). Run `forja cleanup --provider modal`.',
    )
    const note = leftoverNote({ kind: 'unconfirmed', provider: 'modal' }, '')
    expect(note).toContain('run `forja cleanup --provider modal --yes`')
    expect(note).toContain('stops with exit 130')
    expect(leftoverNote({ kind: 'kept', provider: 'runpod' }, '')).toContain('kept them on purpose for debugging')
  })

  test('stored reminders are checked before use', async () => {
    expect(asReminders({ modal: { why: 'x', since: 1, provider: 'modal' }, bad: { why: 2 } })).toEqual({
      modal: { key: 'modal', why: 'x', since: 1, provider: 'modal' },
    })
    expect(asReminders(null)).toEqual({})
    expect(joinPath('/repo', '../x/./y')).toBe('/x/y')
  })
})
