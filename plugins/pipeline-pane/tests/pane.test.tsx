import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { PipelineRun } from '../types'

const T0 = Date.parse('2026-10-30T06:40:00Z')
const RUN_DIR = '/Users/me/.claude-pipeline/runs/run-Ab12Cd'
const PREFIX = `. '${RUN_DIR}/vars.sh' && `
const PIPELINE = '/Users/me/andres-skills/plugins/claude-pipeline/skills/ship/scripts/pipeline.mjs'
// SKILL.md, Setup step 1.
const SETUP =
  'mkdir -p "${CLAUDE_PIPELINE_HOME:-$HOME/.claude-pipeline}/runs" && RUN_DIR=$(mktemp -d "${CLAUDE_PIPELINE_HOME:-$HOME/.claude-pipeline}/runs/run-XXXXXX") && mkdir "$RUN_DIR/logs" && ' +
  `printf "set -u\\nPIPELINE='%s'\\nRUN_DIR='%s'\\n" "${PIPELINE}" "$RUN_DIR" > "$RUN_DIR/vars.sh" && echo "$RUN_DIR"`
const VARS_SH = [
  'set -u',
  `PIPELINE='${PIPELINE}'`,
  `RUN_DIR='${RUN_DIR}'`,
  "KEY='12'",
  "NUMBER='12'",
  "REPO='AndresRubio/sandbox-app'",
  "BRANCH='claude/12-archive-toggle'",
  "MODE='interactive'",
  '',
].join('\n')
const ISSUE_JSON = '{"number":12,"title":"Archive toggle hides the list","body":"...","comments":[]}'

const mark = (stage: string) => `${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage ${stage}`
const TURN_END = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

const PANE = {
  plugin: 'pipeline-pane',
  component: 'Pane',
  requestId: 'pipeline-pane',
  props: {
    title: 'Pipeline',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
const SURFACES = ['terminal', 'desktop'] as const

type World = {
  clock: ReturnType<typeof mock.clock>
  files: Record<string, string>
  store: Record<string, unknown>
  // Output a Bash call prints, by a piece of its command.
  outputs: Record<string, string>
  opened: string[]
  toasts: string[]
  storeSets: number
  fsCalls: number
  agents: number
}

// Stands for the engine beneath the plugin: tools, files, the store, the clock and the UI.
function world(on: On, seed: { store?: Record<string, unknown>; files?: Record<string, string> } = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: T0 }),
    files: { ...seed.files },
    store: { ...seed.store },
    outputs: {},
    opened: [],
    toasts: [],
    storeSets: 0,
    fsCalls: 0,
    agents: 0,
  }
  on('store.get', (_, e) => ({ value: w.store[e.key] }))
  on('store.set', (_, e) => {
    w.store[e.key] = e.value
    w.storeSets += 1
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    w.fsCalls += 1
    const text = w.files[e.path]
    return text === undefined ? { deny: `ENOENT: no such file, ${e.path}` } : { value: text }
  })
  on('fs.exists', (_, e) => {
    w.fsCalls += 1
    return { value: w.files[e.path] !== undefined }
  })
  on('ui.open', (_, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'pipeline-pane' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.run', () => ({ text: '' }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('agent.spawn', () => {
    w.agents += 1
    return { model: 'sonnet', agentId: `a${w.agents}` }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => {
    const command = (e as { command?: unknown }).command
    const found = typeof command === 'string' ? Object.entries(w.outputs).find(([piece]) => command.includes(piece)) : undefined
    return { result: {}, text: found?.[1] ?? '' }
  })
  return w
}

const start = { cwd: '/repo', surface: 'desktop', isInteractive: true } as const
// A slash command as the person types it at the prompt.
const typed = (command: string, args = '') =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
// The Agent tool starting a subagent from the main loop.
const spawn = (description: string, prompt = 'p') =>
  ({
    tool_use_id: `toolu_${description.length}`,
    prompt,
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  }) as const

test('a simulated run: start, two stage changes, a subagent, the finish; drawn on terminal and desktop', async ($, on) => {
  const w = world(on, { files: { [`${RUN_DIR}/issue.json`]: ISSUE_JSON } })
  w.outputs.mktemp = `${RUN_DIR}\n`
  w.outputs['gh pr create'] = 'https://github.com/AndresRubio/sandbox-app/pull/31\n'
  await $.session.start(start)

  // The person types /claude-pipeline:ship #12: the pane opens by itself.
  await $.command.run(typed('claude-pipeline:ship', '#12'))
  expect(w.opened).toEqual(['pipeline-pane'])
  await $.skill.prompt({ skill: 'claude-pipeline:ship', text: '# ship', pluginName: 'claude-pipeline' })
  await $.tool.call({ tool: 'Bash', command: SETUP })
  w.files[`${RUN_DIR}/vars.sh`] = VARS_SH
  await $.tool.call({ tool: 'Bash', command: mark('0') })
  await $.tool.call({ tool: 'Bash', command: `${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --add-label "claude-working"` })
  await w.clock.advance(62_000)

  // Stage change: research, with its subagent.
  await $.tool.call({ tool: 'Bash', command: mark('2') })
  await $.agent.spawn(spawn('Research issue #12', 'What in this repository does issue #12 touch?'))
  await w.clock.advance(190_000)
  await $.turn.complete({ ...TURN_END, agentId: 'a1' })
  await $.tool.call({ tool: 'Write', file_path: '/wt/docs/pipeline/12/research.md', content: '# Research' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts).toContain('#12 Archive toggle hides the list')
    expect(texts).toContain('AndresRubio/sandbox-app · claude/12-archive-toggle · interactive')
    expect(texts).toContain('Running for 4m 12s')
    expect(texts).toContain('▸ 2 Research')
    expect(texts).toContain('3m 10s')
    expect(texts).toContain('✓ 0 Resolve and lock')
    expect(texts).toContain('1m 02s')
    expect(texts).toContain('Grade, Spec, Plan, Build, Verify, Self-review, Finish, Report')
    expect(texts).toContain('wrote research.md · just now')
    expect(texts).toContain('subagent finished: Research issue #12 (3m 10s) · just now')
    await ui.unmount()
  }

  // Stage change: report, then the comment and the lock released.
  await $.tool.call({ tool: 'Bash', command: `${PREFIX}cd "$WT" && gh pr create --repo "$REPO" --base "main" --head "$BRANCH" --title "$(cat "$RUN_DIR/pr-title.txt")" --body-file "$RUN_DIR/pr-body.md"` })
  await $.tool.call({ tool: 'Bash', command: mark('10') })
  await $.tool.call({ tool: 'Bash', command: `${PREFIX}node "$PIPELINE" marker report > "$RUN_DIR/comment.md"` })
  await $.tool.call({ tool: 'Bash', command: `${PREFIX}gh issue comment "$NUMBER" --repo "$REPO" --body-file "$RUN_DIR/comment.md"` })
  await w.clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: `${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --remove-label "claude-working"` })

  expect(w.toasts).toEqual(['Pipeline #12 finished in 4m 42s: PR #31 opened.'])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts).toContain('Finished in 4m 42s · PR #31 opened')
    expect(texts).toContain('✓ 2 Research')
    expect(texts).toContain('✓ 10 Report')
    expect(texts.some(text => text?.startsWith('Next'))).toBe(false)
    await ui.unmount()
  }

  // The last runs are in the store; stage 10's `rm -rf "$RUN_DIR"` starts nothing again.
  const stored = w.store['runs-1'] as PipelineRun[]
  expect(stored[0]?.status).toBe('finished')
  expect(stored[0]?.marks.map(one => one.stage)).toEqual(['0', '2', '10'])
  await $.tool.call({ tool: 'Bash', command: `${PREFIX}rm -rf "$RUN_DIR"` })
  expect(w.opened).toEqual(['pipeline-pane'])
  expect(w.toasts).toHaveLength(1)
})

test('nothing happens while no pipeline runs', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: 'ls ~/.claude-pipeline/runs/' })
  await $.tool.call({ tool: 'Bash', command: 'gh issue edit 3 --add-label bug' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/pipeline/12/notes.md', content: 'x' })
  await $.skill.prompt({ skill: 'superpowers:brainstorming', text: 'x' })
  await $.agent.spawn(spawn('Explore the code'))
  await $.turn.complete(TURN_END)
  await w.clock.advance(60_000)

  expect(w.opened).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.storeSets).toBe(0)
  expect(w.fsCalls).toBe(0)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('No pipeline run yet.')
    await ui.unmount()
  }
  const out = await $.command.run(typed('pipeline-pane'))
  expect(out.text).toBe('No pipeline run yet. Start one with /claude-pipeline:ship #N.')
})

const FINISHED: PipelineRun = {
  id: 'run-1',
  source: '#12',
  isFix: false,
  mode: 'interactive',
  runDir: RUN_DIR,
  key: '12',
  number: '12',
  repo: 'AndresRubio/sandbox-app',
  title: 'Archive toggle hides the list',
  prUrl: 'https://github.com/AndresRubio/sandbox-app/pull/31',
  startedAt: T0 - 3_000_000,
  marks: [
    { stage: '0', at: T0 - 3_000_000 },
    { stage: '6', at: T0 - 2_000_000 },
    { stage: '10', at: T0 - 200_000 },
  ],
  status: 'finished',
  endedAt: T0 - 108_000,
  outcome: 'PR #31 opened',
  hasVars: true,
  subagents: [],
  events: [{ at: T0 - 108_000, text: 'PR #31 opened' }],
}

test('after a restart, /pipeline-pane shows the previous run from the store', async ($, on) => {
  const w = world(on, { store: { 'runs-1': [FINISHED, { id: 'old', stage: 3 }] } })
  await $.session.start(start)

  const out = await $.command.run(typed('pipeline-pane'))
  expect(out.text?.split('\n')[0]).toBe('Last run. Pipeline #12 Archive toggle hides the list: Finished in 48m 12s · PR #31 opened.')
  expect(w.opened).toEqual(['pipeline-pane'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts).toContain('Finished in 48m 12s · PR #31 opened')
    expect(texts).toContain('✓ 6 Build')
    await ui.unmount()
  }
})

test('a stored run left open shows as ended here, and the store keeps what was written', async ($, on) => {
  const running: PipelineRun = { ...FINISHED, id: 'run-2', status: 'running' }
  delete running.outcome
  delete running.endedAt
  const w = world(on, { store: { 'runs-1': [running] } })
  await $.session.start(start)

  const out = await $.command.run(typed('pipeline-pane'))
  expect(out.text?.split('\n')[0]).toBe(
    'Last run. Pipeline #12 Archive toggle hides the list: Stopped at Report after 48m 12s · the session ended before the run did.',
  )
  // Another window may still be running it: nothing is written back.
  expect(w.storeSets).toBe(0)
  expect(w.toasts).toEqual([])
})

test('the run folder: stages.jsonl, vars.sh and issue.json fill the pane, and its removal ends the run', async ($, on) => {
  const w = world(on)
  w.outputs.mktemp = `${RUN_DIR}\n`
  await $.session.start(start)
  await $.tool.call({ tool: 'Skill', skill: 'claude-pipeline:ship', args: '#12 --mode auto' })
  expect(w.opened).toEqual(['pipeline-pane'])
  await $.tool.call({ tool: 'Bash', command: SETUP })

  // Marks the run wrote with no stage-mark call this mod saw (a resumed session, say).
  w.files[`${RUN_DIR}/vars.sh`] = VARS_SH.replace("MODE='interactive'", "MODE='auto'")
  w.files[`${RUN_DIR}/issue.json`] = ISSUE_JSON
  w.files[`${RUN_DIR}/stages.jsonl`] = [
    '{"stage":"0","at":"2026-10-30T06:40:05Z","model":"haiku","effort":"low"}',
    '{"stage":"1","at":"2026-10-30T06:41:07Z","model":"session","effort":"session"}',
    '{"stage":"2","at":"2026-10-30T06:44:47Z","model":"sonnet","effort":"medium"}',
    '',
  ].join('\n')
  await w.clock.advance(300_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts).toContain('#12 Archive toggle hides the list')
    expect(texts).toContain('AndresRubio/sandbox-app · claude/12-archive-toggle · auto')
    expect(texts).toContain('▸ 2 Research')
    expect(texts).toContain('13s')
    expect(texts).toContain('✓ 1 Isolate')
    expect(texts).toContain('3m 40s')
    await ui.unmount()
  }

  delete w.files[`${RUN_DIR}/vars.sh`]
  await w.clock.advance(5_000)
  expect(w.toasts).toEqual(['Pipeline #12 stopped at Research after 5m 05s: run folder removed.'])
})

test('an interactive run waits for the person between turns, and a /clear stops it', async ($, on) => {
  const w = world(on)
  w.outputs.mktemp = `${RUN_DIR}\n`
  await $.session.start(start)
  await $.command.run(typed('claude-pipeline:ship', '#12'))
  await $.tool.call({ tool: 'Bash', command: SETUP })
  w.files[`${RUN_DIR}/vars.sh`] = VARS_SH
  await $.tool.call({ tool: 'Bash', command: mark('5') })
  await w.clock.advance(120_000)
  await $.turn.complete(TURN_END)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toContain('Waiting for you · 2m 00s so far')
  await ui.unmount()

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(w.toasts).toEqual(['Pipeline #12 stopped at Plan after 2m 00s: session cleared; /claude-pipeline:ship 12 resumes it.'])
})
