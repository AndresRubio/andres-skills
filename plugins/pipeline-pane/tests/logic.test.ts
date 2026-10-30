import { describe, expect, test } from 'claude-code/testing'

import type { PipelineRun } from '../types'
import {
  bashSignals,
  bashToSignals,
  endToast,
  fmtDuration,
  heading,
  isRun,
  isSetupCommand,
  isShipSkill,
  endedWithSession,
  mergeStored,
  issueTitle,
  parseShipArgs,
  parseStageLines,
  parseVars,
  pipelineFile,
  reduce,
  runDirFromCommand,
  runDirFromOutput,
  stageRows,
  statusLine,
  toRuns,
} from '../hooks/logic'
import type { Signal } from '../hooks/logic'

const RUN_DIR = '/Users/me/.claude-pipeline/runs/run-GlP2ar'
const PREFIX = `. '${RUN_DIR}/vars.sh' && `
const PIPELINE = '/Users/me/andres-skills/plugins/claude-pipeline/skills/ship/scripts/pipeline.mjs'

// SKILL.md, Setup step 1, with the skill's base directory filled in as the model writes it.
const SETUP =
  'mkdir -p "${CLAUDE_PIPELINE_HOME:-$HOME/.claude-pipeline}/runs" && RUN_DIR=$(mktemp -d "${CLAUDE_PIPELINE_HOME:-$HOME/.claude-pipeline}/runs/run-XXXXXX") && mkdir "$RUN_DIR/logs" && ' +
  `printf "set -u\\nPIPELINE='%s'\\nRUN_DIR='%s'\\n" "${PIPELINE}" "$RUN_DIR" > "$RUN_DIR/vars.sh" && echo "$RUN_DIR"`

// What the real Setup, stages 0 and 1 and stage-mark wrote in a scratch run folder.
const VARS_SH = [
  'set -u',
  `PIPELINE='${PIPELINE}'`,
  `RUN_DIR='${RUN_DIR}'`,
  "KEY='12'",
  "NUMBER='12'",
  "REPO='AndresRubio/sandbox-app'",
  "BRANCH='claude/12-archive-toggle'",
  "WT='/Users/me/.claude-pipeline/worktrees/sandbox app/12'",
  "MODE='interactive'",
  "LANE='manual'",
  '',
].join('\n')
const STAGES_JSONL = [
  '{"stage":"0","at":"2026-10-30T06:40:37Z","model":"haiku","effort":"low"}',
  '{"stage":"1","at":"2026-10-30T06:41:10Z","model":"session","effort":"session"}',
  '{"stage":"2","at":"2026-10-30T06:44:50Z","model":"sonnet","effort":"medium"}',
  '',
].join('\n')

describe('bashSignals', () => {
  test('reads the stage from stage-mark, fix mode included', async () => {
    expect(bashSignals(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 3`)).toEqual([
      { kind: 'stage', stage: '3' },
    ])
    expect(bashSignals(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage fix`)).toEqual([
      { kind: 'stage', stage: 'fix' },
    ])
    expect(bashSignals(`node "${PIPELINE}" stage-mark --run-dir "${RUN_DIR}" --stage 10 --model opus`)).toEqual([
      { kind: 'stage', stage: '10' },
    ])
    // The CLI refuses these too.
    expect(bashSignals(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage nine`)).toEqual([])
    expect(bashSignals('echo stage-mark --stage 3')).toEqual([])
  })

  test('reads labels set and removed through gh (trackers/github.md)', async () => {
    expect(bashSignals(`${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --add-label "claude-working"`)).toEqual([
      { kind: 'label', action: 'add', labels: ['claude-working'], target: { on: 'issue', ref: '$NUMBER' } },
    ])
    expect(bashSignals(`${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --remove-label "claude-working,claude-go"`)).toEqual([
      { kind: 'label', action: 'remove', labels: ['claude-working', 'claude-go'], target: { on: 'issue', ref: '$NUMBER' } },
    ])
    expect(bashSignals(`${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --add-label "needs-decision" && gh issue edit "$NUMBER" --repo "$REPO" --remove-label "claude-working"`)).toEqual([
      { kind: 'label', action: 'add', labels: ['needs-decision'], target: { on: 'issue', ref: '$NUMBER' } },
      { kind: 'label', action: 'remove', labels: ['claude-working'], target: { on: 'issue', ref: '$NUMBER' } },
    ])
    expect(bashSignals(`${PREFIX}gh pr edit 31 --repo "$REPO" --remove-label "claude-fix"`)).toEqual([
      { kind: 'label', action: 'remove', labels: ['claude-fix'], target: { on: 'pr', ref: '31' } },
    ])
  })

  test('reads comment markers, comments, the PR, pushes and the run folder removal', async () => {
    expect(bashSignals(`${PREFIX}node "$PIPELINE" marker report > "$RUN_DIR/comment.md"`)).toEqual([
      { kind: 'marker', marker: 'report' },
    ])
    expect(bashSignals(`${PREFIX}node "$PIPELINE" marker questions > "$RUN_DIR/comment.md"`)).toEqual([
      { kind: 'marker', marker: 'questions' },
    ])
    expect(bashSignals(`${PREFIX}gh issue comment "$NUMBER" --repo "$REPO" --body-file "$RUN_DIR/comment.md"`)).toEqual([
      { kind: 'comment', target: { on: 'issue', ref: '$NUMBER' } },
    ])
    expect(
      bashSignals(`${PREFIX}cd "$WT" && gh pr create --repo "$REPO" --base "main" --head "$BRANCH" --title "$(cat "$RUN_DIR/pr-title.txt")" --body-file "$RUN_DIR/pr-body.md"`),
    ).toEqual([{ kind: 'pr-create' }])
    expect(bashSignals(`${PREFIX}cd "$WT" && git add docs/pipeline/12 && git commit -F "$RUN_DIR/commit-msg.txt" && git push -u origin "$BRANCH"`)).toEqual([
      { kind: 'push', branch: '$BRANCH' },
    ])
    expect(bashSignals(`${PREFIX}rm -rf "$RUN_DIR"`)).toEqual([{ kind: 'run-dir-removed' }])
    expect(bashSignals(`rm -rf '${RUN_DIR}'`)).toEqual([{ kind: 'run-dir-removed' }])
  })

  test('ignores what is not a pipeline step', async () => {
    expect(bashSignals(`${PREFIX}rm -rf "$RUN_DIR/inflight/7"`)).toEqual([])
    expect(bashSignals(`${PREFIX}find "$RUN_DIR/inflight/7" -type f -empty -delete`)).toEqual([])
    expect(bashSignals('git commit -m "docs(pipeline): spec for #12" -m "Co-Authored-By: Claude"')).toEqual([])
    expect(bashSignals('echo marker report')).toEqual([])
    expect(bashSignals('ls ~/.claude-pipeline/runs/')).toEqual([])
    expect(bashSignals('npm test')).toEqual([])
  })
})

describe('the run folder', () => {
  test('Setup is recognised and its output names the folder', async () => {
    expect(isSetupCommand(SETUP)).toBe(true)
    expect(isSetupCommand('ls ~/.claude-pipeline/runs/')).toBe(false)
    expect(runDirFromOutput(`${RUN_DIR}\n`)).toBe(RUN_DIR)
    expect(bashToSignals({ command: SETUP, output: `${RUN_DIR}\n` })).toEqual([{ kind: 'start', via: 'setup', runDir: RUN_DIR }])
  })

  test('a command that sources vars.sh names the folder; one that only mentions it does not', async () => {
    expect(runDirFromCommand(`${PREFIX}node "$PIPELINE" config > "$RUN_DIR/config.json"`)).toBe(RUN_DIR)
    expect(runDirFromCommand(`node "${PIPELINE}" stage-mark --run-dir '${RUN_DIR}' --stage 2`)).toBe(RUN_DIR)
    expect(runDirFromCommand(`cat '${RUN_DIR}/vars.sh'`)).toBeUndefined()
    expect(runDirFromCommand(SETUP)).toBeUndefined()
  })

  test('vars.sh, stages.jsonl and issue.json parse as the plugin writes them', async () => {
    const vars = parseVars(`${VARS_SH}NOTE='it'\\''s'\n`)
    expect(vars.KEY).toBe('12')
    expect(vars.BRANCH).toBe('claude/12-archive-toggle')
    expect(vars.WT).toBe('/Users/me/.claude-pipeline/worktrees/sandbox app/12')
    expect(vars.NOTE).toBe("it's")
    // A torn last line (a killed write) is no mark, as run-record.mjs reads it.
    const marks = parseStageLines(`${STAGES_JSONL}{"stage":"3","at":"2026-10-3`)
    expect(marks.map(mark => mark.stage)).toEqual(['0', '1', '2'])
    expect(marks[1]?.at).toBe(Date.parse('2026-10-30T06:41:10Z'))
    expect(issueTitle('{"number":12,"title":"Archive toggle hides the list","body":"x"}')).toBe('Archive toggle hides the list')
    expect(issueTitle('not json')).toBeUndefined()
  })

  test('only files under docs/pipeline/<KEY>/ count as the run writing', async () => {
    expect(pipelineFile('/Users/me/.claude-pipeline/worktrees/app/12/docs/pipeline/12/research.md')).toBe('research.md')
    expect(pipelineFile('/wt/docs/pipeline/12/screenshots/after.png')).toBe('screenshots/after.png')
    expect(pipelineFile('/wt/src/list.ts')).toBeUndefined()
    expect(pipelineFile(undefined)).toBeUndefined()
  })
})

test('the /ship arguments and the skill', async () => {
  expect(parseShipArgs('#12')).toEqual({ source: '#12', mode: 'interactive', isFix: false })
  expect(parseShipArgs('#12 --mode auto')).toEqual({ source: '#12', mode: 'auto', isFix: false })
  expect(parseShipArgs('https://github.com/o/r/pull/31 --fix')).toEqual({ source: 'https://github.com/o/r/pull/31', mode: 'interactive', isFix: true })
  expect(parseShipArgs('"add a dark mode toggle"')).toEqual({ source: 'add a dark mode toggle', mode: 'interactive', isFix: false })
  expect(isShipSkill('claude-pipeline:ship')).toBe(true)
  expect(isShipSkill('ship', undefined, '/x/plugins/claude-pipeline/skills/ship/SKILL.md')).toBe(true)
  expect(isShipSkill('ship')).toBe(false)
  expect(isShipSkill('claude-pipeline:review', 'claude-pipeline')).toBe(false)
})

const T0 = 1_000_000

// Runs signals one at a time at the given offsets from T0.
function play(steps: ReadonlyArray<[number, Signal]>, start: PipelineRun | null = null) {
  let run = start
  const closed: PipelineRun[] = []
  for (const [offset, signal] of steps) {
    const step = reduce({ run, closedRunDirs: [] }, [signal], T0 + offset)
    run = step.run
    closed.push(...step.closed)
  }
  return { run, closed }
}

const bash = (command: string, output = ''): Signal[] => bashToSignals({ command, output })
const at = (offset: number, signals: Signal[]) => signals.map(signal => [offset, signal] as [number, Signal])

describe('reduce', () => {
  test('a run that stops at the grade with questions', async () => {
    const { run, closed } = play([
      [0, { kind: 'start', via: 'command', args: '#12 --mode auto' }],
      [1_000, { kind: 'start', via: 'skill-prompt' }],
      ...at(2_000, bash(SETUP, `${RUN_DIR}\n`)),
      [3_000, { kind: 'vars', vars: parseVars(VARS_SH.replace("MODE='interactive'", "MODE='auto'")) }],
      ...at(4_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 0`)),
      ...at(60_000, bash(`${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --add-label "claude-working"`)),
      ...at(120_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 3`)),
      ...at(300_000, bash(`${PREFIX}node "$PIPELINE" marker questions > "$RUN_DIR/comment.md"`)),
      ...at(301_000, bash(`${PREFIX}gh issue comment "$NUMBER" --repo "$REPO" --body-file "$RUN_DIR/comment.md"`)),
      ...at(302_000, bash(`${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --add-label "needs-decision"`)),
      ...at(303_000, bash(`${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --remove-label "claude-working"`)),
    ])

    expect(run).toBeNull()
    expect(closed).toHaveLength(1)
    const done = closed[0] as PipelineRun
    expect(done.status).toBe('stopped')
    expect(done.outcome).toBe('questions posted on the issue')
    expect(done.runDir).toBe(RUN_DIR)
    expect(done.mode).toBe('auto')
    expect(done.events.map(event => event.text)).toContain('added label needs-decision to #12')
    expect(endToast(done)).toBe('Pipeline #12 stopped at Grade after 5m 03s: questions posted on the issue.')
  })

  test('a run that reaches stage 10 finishes with its PR', async () => {
    const { closed } = play([
      [0, { kind: 'start', via: 'command', args: '#12' }],
      [1_000, { kind: 'vars', vars: parseVars(VARS_SH) }],
      ...at(2_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 9`)),
      ...at(3_000, bash(`${PREFIX}cd "$WT" && gh pr create --repo "$REPO" --base "main" --head "$BRANCH" --title "$(cat "$RUN_DIR/pr-title.txt")" --body-file "$RUN_DIR/pr-body.md"`, 'https://github.com/AndresRubio/sandbox-app/pull/31\n')),
      // Stage 9 writes the PR body's marker too: it is no comment, so it ends nothing.
      ...at(4_000, bash(`${PREFIX}node "$PIPELINE" marker report > "$RUN_DIR/pr-marker.txt"`)),
      ...at(5_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 10`)),
      ...at(6_000, bash(`${PREFIX}node "$PIPELINE" marker report > "$RUN_DIR/comment.md"`)),
      ...at(7_000, bash(`${PREFIX}gh issue comment "$NUMBER" --repo "$REPO" --body-file "$RUN_DIR/comment.md"`)),
      ...at(8_000, bash(`${PREFIX}gh issue edit "$NUMBER" --repo "$REPO" --remove-label "claude-working"`)),
    ])

    expect(closed[0]?.status).toBe('finished')
    expect(closed[0]?.outcome).toBe('PR #31 opened')
    expect(closed[0] && endToast(closed[0])).toBe('Pipeline #12 finished in 8s: PR #31 opened.')
  })

  test('the same stage-mark from the tool call and from stages.jsonl is one stage', async () => {
    const { run } = play([
      [0, { kind: 'start', via: 'command', args: '#12' }],
      ...at(5_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 2`)),
      [6_000, { kind: 'stage', stage: '2', at: T0 + 4_000 }],
      [7_000, { kind: 'stage', stage: '1', at: T0 + 1_000 }],
    ])
    expect(run?.marks.map(mark => mark.stage)).toEqual(['1', '2'])
  })

  test('an interactive run waits when the turn ends; an automatic one ends', async () => {
    const interactive = play([
      [0, { kind: 'start', via: 'command', args: '#12' }],
      ...at(1_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 3`)),
      [2_000, { kind: 'turn-end', isAborted: false }],
    ])
    expect(interactive.run?.status).toBe('waiting')
    expect(play([[3_000, { kind: 'turn-start' }]], interactive.run).run?.status).toBe('running')

    const automatic = play([
      [0, { kind: 'start', via: 'skill-tool', args: '#12 --mode auto' }],
      ...at(1_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 6`)),
      [2_000, { kind: 'turn-end', isAborted: false }],
    ])
    expect(automatic.closed[0]?.status).toBe('stopped')
    expect(automatic.closed[0]?.outcome).toBe('the run ended without a report')
  })

  test('a subagent shows from its spawn to its turn end', async () => {
    const { run } = play([
      [0, { kind: 'start', via: 'command', args: '#12' }],
      [1_000, { kind: 'agent-start', id: 'a1', description: 'Research issue #12' }],
      [2_000, { kind: 'agent-end', id: 'other' }],
    ])
    expect(run?.subagents.map(agent => agent.id)).toEqual(['a1'])
    const ended = play([[191_000, { kind: 'agent-end', id: 'a1' }]], run)
    expect(ended.run?.subagents).toEqual([])
    expect(ended.run?.events.at(-1)?.text).toBe('subagent finished: Research issue #12 (3m 10s)')
  })

  test('a new /ship replaces an open run; a skill prompt or Setup again does not', async () => {
    const first = play([
      [0, { kind: 'start', via: 'command', args: '#12' }],
      ...at(1_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 4`)),
    ])
    const again = play(
      [
        [600_000, { kind: 'start', via: 'skill-prompt' }],
        [601_000, { kind: 'start', via: 'setup', runDir: '/Users/me/.claude-pipeline/runs/run-New123' }],
      ],
      first.run,
    )
    expect(again.closed).toEqual([])
    expect(again.run?.runDir).toBe('/Users/me/.claude-pipeline/runs/run-New123')
    expect(again.run?.marks.map(mark => mark.stage)).toEqual(['4'])

    const replaced = play([[700_000, { kind: 'start', via: 'command', args: '#13' }]], again.run)
    expect(replaced.closed[0]?.outcome).toBe('a new run started')
    expect(replaced.run?.source).toBe('#13')
  })

  test('a folder a closed run used does not start a run again', async () => {
    const step = reduce({ run: null, closedRunDirs: [RUN_DIR] }, bash(`${PREFIX}rm -rf "$RUN_DIR"`), T0)
    expect(step.run).toBeNull()
    expect(step.started).toBe(false)
  })

  test('the run folder vanishing ends the run', async () => {
    const { closed } = play([
      [0, { kind: 'start', via: 'command', args: '#12' }],
      ...at(1_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 2`)),
      [2_000, { kind: 'run-dir-gone' }],
    ])
    expect(closed[0]?.status).toBe('stopped')
    expect(closed[0]?.outcome).toBe('run folder removed')
  })
})

test('stage rows give each finished stage its time and the running one its elapsed time', async () => {
  const { run } = play([
    [0, { kind: 'start', via: 'command', args: '"add a dark mode toggle"' }],
    ...at(0, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 0`)),
    ...at(62_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 1`)),
    ...at(282_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 2`)),
  ])
  if (run === null) throw new Error('no run')
  const rows = stageRows(run, T0 + 400_000)
  expect(rows.done.map(row => `${row.label} ${fmtDuration(row.ms)}`)).toEqual(['0 Resolve and lock 1m 02s', '1 Isolate 3m 40s'])
  expect(rows.current?.label).toBe('2 Research')
  expect(fmtDuration(rows.current?.ms ?? 0)).toBe('1m 58s')
  expect(rows.next).toEqual(['Grade', 'Spec', 'Plan', 'Build', 'Verify', 'Self-review', 'Finish', 'Report'])
  expect(heading(run)).toBe('Idea: "add a dark mode toggle"')
  expect(statusLine(run, T0 + 400_000)).toBe('Running for 6m 40s')
  expect(fmtDuration(3_725_000)).toBe('1h 02m')
})

test('merging with the shared store: the copy that saw something later wins, the stored one on a tie', async () => {
  const live = play([
    [0, { kind: 'start', via: 'command', args: '#12' }],
    ...at(1_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 6`)),
  ]).run
  if (live === null) throw new Error('no run')
  // This session sees another window's open run and shows it as ended at its last mark.
  const shownHere = endedWithSession(live)
  expect(shownHere.status).toBe('stopped')
  expect(shownHere.endedAt).toBe(T0 + 1_000)
  expect(mergeStored([shownHere], [live])[0]?.status).toBe('running')
  // The other window marks stage 7 and saves: its copy is newer still.
  const later = play(at(9_000, bash(`${PREFIX}node "$PIPELINE" stage-mark --run-dir "$RUN_DIR" --stage 7`)), live).run
  if (later === null) throw new Error('no run')
  expect(mergeStored([shownHere], [later])[0]?.marks.map(one => one.stage)).toEqual(['6', '7'])
  // A run this session finished is newer than the open copy in the store.
  const done = play([[20_000, { kind: 'run-dir-gone' }]], later).closed[0]
  if (done === undefined) throw new Error('not closed')
  expect(mergeStored([done], [later])[0]?.status).toBe('stopped')
})

test('the store keeps only runs this version can read', async () => {
  const { run } = play([[0, { kind: 'start', via: 'command', args: '#12' }]])
  expect(isRun(run)).toBe(true)
  expect(toRuns([run, { id: 'old', stage: 3 }, 'junk', null])).toHaveLength(1)
  expect(toRuns('nope')).toEqual([])
})
