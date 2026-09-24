import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gradeVerdict, CHECKLIST_FIELDS } from '../skills/ship/scripts/lib/grade.mjs';
import { runCli } from './helpers/cli.mjs';
import { tempDir } from './helpers/git.mjs';

const LIMITS = { maxPrSize: { files: 6, lines: 250 }, mode: 'auto' };
const base = () => ({
  estimatedFiles: 2, estimatedLines: 60, estimatedTasks: 2, independentSubsystems: false,
  assumptions: [], missingValues: [], changesUserVisibleBehaviourNotInIssue: false,
  changesDataModelApiAuthOrDeps: false, acceptanceCriteriaDerivable: true,
  needsWorkflowChanges: false, conflictsWithOpenClaudePr: false, claudeGo: false,
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
  assert.equal(grade({ conflictsWithOpenClaudePr: true }).verdict, 'fork');
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

test('invalid checklists are rejected', () => {
  const { claudeGo, ...missing } = base();
  assert.throws(() => gradeVerdict(missing, LIMITS), /"claudeGo" must be boolean/);
  assert.throws(() => gradeVerdict({ ...base(), extra: 1 }, LIMITS), /unknown field "extra"/);
  assert.throws(() => gradeVerdict({ ...base(), estimatedFiles: -1 }, LIMITS), /estimatedFiles/);
  assert.equal(Object.keys(CHECKLIST_FIELDS).length, 12);
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
