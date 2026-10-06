import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gradeVerdict, CHECKLIST_FIELDS } from '../skills/ship/scripts/lib/grade.mjs';
import { waitingFor } from '../skills/ship/scripts/lib/runs.mjs';
import { runCli } from './helpers/cli.mjs';
import { tempDir } from './helpers/git.mjs';

const LIMITS = { maxPrSize: { files: 6, lines: 250 }, mode: 'auto' };
const base = () => ({
  estimatedFiles: 2, estimatedLines: 60, estimatedTasks: 2, independentSubsystems: false,
  assumptions: [], missingValues: [], changesUserVisibleBehaviourNotInIssue: false,
  changesDataModelApiAuthOrDeps: false, acceptanceCriteriaDerivable: true,
  needsWorkflowChanges: false, waitFor: [], waitOverride: false, claudeGo: false,
});
const grade = (over, limits = LIMITS) => gradeVerdict({ ...base(), ...over }, limits);

test('no assumptions is ready; 1-3 assumptions are small gaps', () => {
  assert.deepEqual(grade({}), { verdict: 'ready', reasons: [] });
  assert.equal(grade({ assumptions: ['Assume A', 'Assume B'] }).verdict, 'small-gaps');
});

test('each fork rule forks', () => {
  assert.equal(grade({ assumptions: ['a', 'b', 'c', 'd'] }).verdict, 'fork');
  assert.equal(grade({ changesUserVisibleBehaviourNotInIssue: true }).verdict, 'fork');
  assert.equal(grade({ changesDataModelApiAuthOrDeps: true }).verdict, 'fork');
  assert.equal(grade({ acceptanceCriteriaDerivable: false }).verdict, 'fork');
  assert.match(grade({ missingValues: ['the new price'] }).reasons[0], /missing value: the new price/);
});

test('claude-go skips the fork rules but not missing values', () => {
  assert.equal(grade({ claudeGo: true, assumptions: ['a', 'b', 'c', 'd', 'e'] }).verdict, 'small-gaps');
  assert.equal(grade({ claudeGo: true, changesDataModelApiAuthOrDeps: true }).verdict, 'ready');
  assert.equal(grade({ claudeGo: true, missingValues: ['x'] }).verdict, 'fork');
});

test('workflow changes fork in automatic mode only, even with claude-go', () => {
  assert.equal(grade({ needsWorkflowChanges: true, claudeGo: true }).verdict, 'fork');
  assert.equal(grade({ needsWorkflowChanges: true }, { ...LIMITS, mode: 'interactive' }).verdict, 'ready');
});

test('too-big by files, lines, tasks or subsystems, and it wins over fork', () => {
  assert.equal(grade({ estimatedFiles: 7 }).verdict, 'too-big');
  assert.equal(grade({ estimatedLines: 251 }).verdict, 'too-big');
  assert.equal(grade({ estimatedTasks: 9 }).verdict, 'too-big');
  assert.equal(grade({ independentSubsystems: true }).verdict, 'too-big');
  assert.equal(grade({ estimatedFiles: 7, changesDataModelApiAuthOrDeps: true }).verdict, 'too-big');
  assert.equal(grade({ estimatedFiles: 7, needsWorkflowChanges: true }).verdict, 'fork');
});

test('missing values fork before the size check, even when also too-big', () => {
  const r = grade({ estimatedFiles: 7, missingValues: ['the new price'] });
  assert.equal(r.verdict, 'fork');
  assert.match(r.reasons[0], /missing value: the new price/);
});

test('invalid checklists are rejected', () => {
  const { claudeGo, ...missing } = base();
  assert.throws(() => gradeVerdict(missing, LIMITS), /"claudeGo" must be boolean/);
  assert.throws(() => gradeVerdict({ ...base(), extra: 1 }, LIMITS), /unknown field "extra"/);
  assert.throws(() => gradeVerdict({ ...base(), estimatedFiles: -1 }, LIMITS), /estimatedFiles/);
  assert.equal(Object.keys(CHECKLIST_FIELDS).length, 13);
});

test('a checklist field named constructor is rejected as unknown, not treated as a prototype property', () => {
  assert.throws(() => gradeVerdict({ ...base(), constructor: 1 }, LIMITS), /unknown field "constructor"/);
});

test('CLI grade reads the checklist and the config limits', () => {
  const dir = tempDir();
  const checklist = path.join(dir, 'checklist.json');
  const config = path.join(dir, 'config.json');
  writeFileSync(checklist, JSON.stringify({ ...base(), estimatedFiles: 7 }));
  writeFileSync(config, JSON.stringify({ maxPrSize: { files: 6, lines: 250 } }));
  const r = runCli(['grade', '--checklist-file', checklist, '--config-file', config, '--mode', 'auto']);
  assert.equal(r.json().verdict, 'too-big', r.stderr);
  assert.equal(runCli(['grade', '--checklist-file', checklist, '--config-file', config, '--mode', 'yolo']).code, 2);
});

// --- D16: waiting for runs ahead ---

const lockRun = (key, over = {}) => ({
  key, issue: Number(key), pr: null, branch: `claude/${key}-x`, title: 't', body: 'b', textWithheld: false,
  lockedAt: '2026-10-06T10:00:00Z', lockId: Number(key) * 10, related: false, ...over,
});
const RUNS = Object.freeze({
  self: { key: '5', lockedAt: '2026-10-06T11:00:00Z', lockId: 900 },
  runs: [
    lockRun('8', { pr: 30, branch: 'claude/8-x' }),
    { ...lockRun('PR-41'), issue: null, pr: 41, branch: 'claude/x', lockedAt: null, lockId: null },
    { ...lockRun('lin-4'), issue: null, pr: 42, branch: 'claude/lin-4-y', lockedAt: null, lockId: null },
    { ...lockRun('pr-12'), issue: null, pr: 43, branch: 'claude/pr-12-z', lockedAt: null, lockId: null },
    lockRun('7'),
    lockRun('3', { related: true }),
    lockRun('12', { lockedAt: '2026-10-06T11:30:00Z' }),
  ],
  ahead: ['8', 'PR-41', 'lin-4', 'pr-12', '7', '3'],
  maxParallel: 9,
  admitted: true,
});
const WAIT = { ...LIMITS, activeRuns: RUNS };

test('wait: a kept run ahead gives the verdict wait, with waitFor and waitLine', () => {
  assert.deepEqual(grade({ waitFor: ['7', '8'] }, WAIT), {
    verdict: 'wait',
    reasons: ['overlaps #7, a run ahead of this one', 'overlaps #8, a run ahead of this one'],
    waitFor: ['7', '8'],
    waitLine: 'Waiting for: 7, 8',
  });
  assert.equal(grade({ waitFor: ['7'] }, { ...WAIT, mode: 'interactive' }).verdict, 'wait');
});

test('wait: waitOverride suppresses the wait and notes it; claudeGo alone does not', () => {
  assert.deepEqual(grade({ waitFor: ['7', '8'], waitOverride: true }, WAIT), {
    verdict: 'ready', reasons: [], notes: ['went ahead alongside #7, #8'],
  });
  assert.deepEqual(grade({ waitFor: ['7'], waitOverride: true, assumptions: ['Assume A'] }, WAIT), {
    verdict: 'small-gaps', reasons: ['1 assumption(s) to record'], notes: ['went ahead alongside #7'],
  });
  assert.equal(grade({ waitFor: ['7'], claudeGo: true }, WAIT).verdict, 'wait');
});

test('wait: a malformed key throws, duplicates are removed, and a run with issue null is dropped with its note', () => {
  for (const bad of ['#7', 'PR #41', '7 ', '', 'Lin-4']) {
    assert.throws(() => grade({ waitFor: [bad] }, WAIT), (err) => err.message === `waitFor "${bad}" is not a run key`);
    assert.throws(() => grade({ waitFor: ['7', bad], waitOverride: true }, WAIT), /is not a run key/);
  }
  assert.deepEqual(grade({ waitFor: ['7', '7'] }, WAIT), {
    verdict: 'wait', reasons: ['overlaps #7, a run ahead of this one'], waitFor: ['7'], waitLine: 'Waiting for: 7',
  });
  assert.deepEqual(grade({ waitFor: ['PR-41', 'lin-4', 'pr-12'] }, WAIT), {
    verdict: 'ready',
    reasons: [],
    notes: [
      "PR #41 isn't a pipeline issue run; it counts for room only",
      "lin-4 isn't a pipeline issue run; it counts for room only",
      "pr-12 isn't a pipeline issue run; it counts for room only",
    ],
  });
});

test('wait: fork, the workflow fork, missing values and too-big all beat wait', () => {
  assert.equal(grade({ waitFor: ['7'], changesDataModelApiAuthOrDeps: true }, WAIT).verdict, 'fork');
  assert.equal(grade({ waitFor: ['7'], needsWorkflowChanges: true, claudeGo: true }, WAIT).verdict, 'fork');
  assert.equal(grade({ waitFor: ['7'], missingValues: ['the price'] }, WAIT).verdict, 'fork');
  assert.equal(grade({ waitFor: ['7'], estimatedFiles: 7 }, WAIT).verdict, 'too-big');
  assert.equal(grade({ waitFor: ['7'], claudeGo: true, changesDataModelApiAuthOrDeps: true }, WAIT).verdict, 'wait');
});

test('wait: a key no longer ahead and a related key are dropped with their notes, and the verdict falls through to ready', () => {
  assert.deepEqual(grade({ waitFor: ['12', '99', '3'] }, WAIT), {
    verdict: 'ready',
    reasons: [],
    notes: ['#12 is no longer a run ahead of this one', '#99 is no longer a run ahead of this one', "#3 is this issue's parent or sub-issue"],
  });
});

test('wait: notes ride on any verdict, and the went-ahead note only appears when the run goes ahead', () => {
  assert.deepEqual(grade({ waitFor: ['12', '7'], waitOverride: true, changesDataModelApiAuthOrDeps: true }, WAIT), {
    verdict: 'fork',
    reasons: ['changes the data model, a public API, auth or security, or adds a dependency'],
    notes: ['#12 is no longer a run ahead of this one'],
  });
  assert.deepEqual(grade({ waitFor: ['12', '7'] }, WAIT), {
    verdict: 'wait',
    reasons: ['overlaps #7, a run ahead of this one'],
    waitFor: ['7'],
    waitLine: 'Waiting for: 7',
    notes: ['#12 is no longer a run ahead of this one'],
  });
});

test('wait: a missing activeRuns and a null self.lockedAt both throw, even with waitOverride', () => {
  for (const waitOverride of [false, true]) {
    assert.throws(() => grade({ waitFor: ['7'], waitOverride }, LIMITS), /^Error: --active-runs-file is required when waitFor is not empty$/);
    const before = { ...RUNS, self: { key: '5', lockedAt: null, lockId: null } };
    assert.throws(() => grade({ waitFor: ['7'], waitOverride }, { ...LIMITS, activeRuns: before }), /^Error: waitFor needs a count taken after the lock$/);
    const { self, ...noSelf } = RUNS;
    assert.throws(() => grade({ waitFor: ['7'], waitOverride }, { ...LIMITS, activeRuns: noSelf }), /^Error: waitFor needs a count taken after the lock$/);
  }
});

test('wait: an empty waitFor needs no activeRuns', () => {
  assert.deepEqual(grade({}, LIMITS), { verdict: 'ready', reasons: [] });
  assert.deepEqual(grade({ waitOverride: true }, LIMITS), { verdict: 'ready', reasons: [] });
});

test('the checklist rejects conflictsWithOpenClaudePr as unknown and needs waitFor and waitOverride', () => {
  assert.throws(() => grade({ conflictsWithOpenClaudePr: false }), /unknown field "conflictsWithOpenClaudePr"/);
  const { waitOverride, ...noOverride } = base();
  assert.throws(() => gradeVerdict(noOverride, LIMITS), /"waitOverride" must be boolean/);
  const { waitFor, ...noWaitFor } = base();
  assert.throws(() => gradeVerdict(noWaitFor, LIMITS), /"waitFor" must be string\[\]/);
  assert.throws(() => grade({ waitFor: [7] }), /"waitFor" must be string\[\]/);
});

test('CLI grade: a non-empty waitFor needs --active-runs-file (exit 2), and with it gives the wait', () => {
  const dir = tempDir();
  const checklist = path.join(dir, 'checklist.json');
  const config = path.join(dir, 'config.json');
  const runs = path.join(dir, 'active-runs.json');
  writeFileSync(checklist, JSON.stringify({ ...base(), waitFor: ['7'] }));
  writeFileSync(config, JSON.stringify({ maxPrSize: { files: 6, lines: 250 } }));
  writeFileSync(runs, JSON.stringify(RUNS));
  const missing = runCli(['grade', '--checklist-file', checklist, '--config-file', config, '--mode', 'auto']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--active-runs-file is required when waitFor is not empty/);
  const r = runCli(['grade', '--checklist-file', checklist, '--config-file', config, '--mode', 'auto', '--active-runs-file', runs]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { verdict: 'wait', reasons: ['overlaps #7, a run ahead of this one'], waitFor: ['7'], waitLine: 'Waiting for: 7' });
  const before = path.join(dir, 'before.json');
  writeFileSync(before, JSON.stringify({ ...RUNS, self: { key: '5', lockedAt: null, lockId: null } }));
  const early = runCli(['grade', '--checklist-file', checklist, '--config-file', config, '--mode', 'auto', '--active-runs-file', before]);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /waitFor needs a count taken after the lock/);
  writeFileSync(checklist, JSON.stringify(base()));
  assert.equal(runCli(['grade', '--checklist-file', checklist, '--config-file', config, '--mode', 'auto']).json().verdict, 'ready');
});

test('wait: the waitLine, posted last in a deferred comment the way stage 3 posts it, reads back as the same keys', () => {
  const runs = {
    ...RUNS,
    runs: [...RUNS.runs, lockRun('10'), lockRun('100')],
    ahead: [...RUNS.ahead, '10', '100'],
  };
  const verdict = grade({ waitFor: ['100', '7', '10', '7', 'PR-41'] }, { ...LIMITS, activeRuns: runs });
  assert.deepEqual(verdict.waitFor, ['100', '7', '10']);
  const at = '2026-10-06T11:05:00Z';
  const body = [
    `**[claude-pipeline]** deferred · ${at} · local`, '', '# Grade — 5', '', '**Verdict:** `wait`', '',
    '## Waiting for', '', '- #7 (same-code): src/list.ts:12', '',
    'This issue becomes eligible again once none of these runs is in progress: the sweep or the next poll picks it up, or run `/ship #5` again. To run it alongside them anyway, add `claude-go`.',
    verdict.waitLine,
  ].join('\n');
  const issue = { labels: ['claude'], comments: [{ id: 9, author: 'claude[bot]', authorAssociation: 'NONE', createdAt: at, body, marker: { kind: 'deferred', at, run: 'local' } }] };
  assert.deepEqual(waitingFor(issue), verdict.waitFor);
});

test('wait beats small-gaps: one kept key plus assumptions, without an override, is wait', () => {
  assert.deepEqual(grade({ waitFor: ['7'], assumptions: ['Assume A'] }, WAIT), {
    verdict: 'wait', reasons: ['overlaps #7, a run ahead of this one'], waitFor: ['7'], waitLine: 'Waiting for: 7',
  });
});

test('fork and too-big carry waitFor and waitLine when kept keys remain, so the interactive paths can ask the wait question', () => {
  const kept = { waitFor: ['7', '8'], waitLine: 'Waiting for: 7, 8' };
  assert.deepEqual(grade({ waitFor: ['7', '8'], changesDataModelApiAuthOrDeps: true }, WAIT), {
    verdict: 'fork', reasons: ['changes the data model, a public API, auth or security, or adds a dependency'], ...kept,
  });
  assert.deepEqual(grade({ waitFor: ['7', '8'], missingValues: ['the price'] }, WAIT), {
    verdict: 'fork', reasons: ['missing value: the price'], ...kept,
  });
  assert.deepEqual(grade({ waitFor: ['7', '8'], needsWorkflowChanges: true }, WAIT), {
    verdict: 'fork', reasons: ['needs .github/workflows changes, which automatic lanes may not make'], ...kept,
  });
  assert.deepEqual(grade({ waitFor: ['7', '12', '8'], estimatedFiles: 7 }, WAIT), {
    verdict: 'too-big', reasons: ['estimated 7 files > limit 6'], ...kept, notes: ['#12 is no longer a run ahead of this one'],
  });
});

test('with waitOverride, fork and too-big carry no waitFor or waitLine; ready and small-gaps never do', () => {
  for (const over of [{ changesDataModelApiAuthOrDeps: true }, { estimatedFiles: 7 }]) {
    const r = grade({ waitFor: ['7'], waitOverride: true, ...over }, WAIT);
    assert.equal('waitFor' in r || 'waitLine' in r, false, JSON.stringify(r));
  }
  for (const r of [grade({}, WAIT), grade({ waitFor: ['12'] }, WAIT), grade({ assumptions: ['Assume A'], waitFor: ['3'] }, WAIT)]) {
    assert.ok(['ready', 'small-gaps'].includes(r.verdict), JSON.stringify(r));
    assert.equal('waitFor' in r || 'waitLine' in r, false, JSON.stringify(r));
  }
});
