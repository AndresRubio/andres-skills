import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STAGE_POLICY, stageMark, readStages, stageTimings, buildRun, appendRun, summaryLine, loadUsage } from '../skills/ship/scripts/lib/run-record.mjs';
import { runCli } from './helpers/cli.mjs';
import { git, makeRepoWithOrigin, tempDir, writeFiles } from './helpers/git.mjs';

test('stageMark appends the policy tier and effort unless the caller names others', () => {
  const runDir = tempDir('run-');
  assert.deepEqual(stageMark(runDir, { stage: '2', now: new Date('2026-10-20T10:00:00Z') }), { stage: '2', at: '2026-10-20T10:00:00Z', model: 'sonnet', effort: 'medium' });
  stageMark(runDir, { stage: '8', effort: 'max', now: new Date('2026-10-20T10:10:00Z') });
  assert.deepEqual(readStages(runDir).map((s) => [s.stage, s.model, s.effort]), [['2', 'sonnet', 'medium'], ['8', 'strongest', 'max']]);
  assert.throws(() => stageMark(runDir, { stage: '11' }), /unknown stage/);
  assert.deepEqual(STAGE_POLICY['0'], { model: 'haiku', effort: 'low' });
  assert.deepEqual(STAGE_POLICY['3'], { model: 'strongest', effort: 'high' });
});

test('STAGE_POLICY follows the Model policy table in SKILL.md', () => {
  const skill = readFileSync(new URL('../skills/ship/SKILL.md', import.meta.url), 'utf8');
  const rows = skill.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Work') && !l.startsWith('|---'));
  assert.ok(rows.length >= 4, 'the table has its rows');
  // Stages named by a row of that table. 1, 9 and fix have no row of their own.
  const expected = { 0: ['haiku', 'low'], 2: ['sonnet', 'medium'], 3: ['strongest', 'high'], 4: ['strongest', 'high'], 5: ['strongest', 'high'], 6: ['sonnet', 'medium'], 7: ['sonnet', 'medium'], 8: ['strongest', 'high'] };
  for (const [stage, [model, effort]] of Object.entries(expected)) assert.deepEqual([STAGE_POLICY[stage].model, STAGE_POLICY[stage].effort], [model, effort], `stage ${stage}`);
  assert.match(skill, /Tracker queries, labels, resolve and lock \| haiku \| low/);
  assert.match(skill, /Research, implementers, evidence write-up \| sonnet \| medium/);
  assert.match(skill, /Grade, spec, plan \| strongest available \| high/);
  assert.match(skill, /Stage 8 review[^|]*\| strongest available \| high/);
  assert.deepEqual(STAGE_POLICY[1], { model: 'session', effort: 'session' });
  assert.deepEqual(STAGE_POLICY[9], { model: 'session', effort: 'session' });
});

test('stageTimings: each stage lasts until the next mark, the last until finishedAt', () => {
  const t = stageTimings([{ stage: '0', at: '2026-10-20T10:00:00Z', model: 'haiku', effort: 'low' }, { stage: '1', at: '2026-10-20T10:01:30Z', model: 'session', effort: 'session' }], '2026-10-20T10:05:00Z');
  assert.deepEqual(t.map((s) => [s.stage, s.seconds]), [['0', 90], ['1', 210]]);
});

test('stageTimings orders marks by time, accepts milliseconds, and drops marks without a usable time', () => {
  const mark = (stage, at) => ({ stage, at, model: 'm', effort: 'e' });
  const t = stageTimings([mark('1', '2026-10-20T10:01:30.400Z'), mark('0', '2026-10-20T10:00:00Z'), mark('x', 'not a time'), { stage: 'y' }, mark('2', '2026-10-20T10:03:00Z')], '2026-10-20T10:05:00Z');
  assert.deepEqual(t.map((s) => [s.stage, s.seconds]), [['0', 90], ['1', 90], ['2', 120]]);
  // A finish before the last mark never gives a negative duration.
  assert.deepEqual(stageTimings([mark('0', '2026-10-20T10:10:00Z')], '2026-10-20T10:00:00Z').map((s) => s.seconds), [0]);
});

test('readStages skips a torn line', () => {
  const runDir = tempDir('run-');
  stageMark(runDir, { stage: '0', now: new Date('2026-10-20T10:00:00Z') });
  appendFileSync(path.join(runDir, 'stages.jsonl'), '{"stage":"1","at":"2026-10-2');
  assert.deepEqual(readStages(runDir).map((s) => s.stage), ['0']);
  assert.deepEqual(readStages(tempDir('empty-')), []);
});

test('buildRun without usage writes nulls; appendRun keeps earlier runs; summaryLine totals them', () => {
  const base = { key: '12', runId: 'run-x', lane: 'github', mode: 'auto', pluginVersion: '0.3.0', sessionEffort: 'default', size: { files: 2, lines: 30, testFiles: 1 }, fixRunsBefore: 0 };
  const stages = [{ stage: '0', at: '2026-10-20T10:00:00Z', model: 'haiku', effort: 'low' }];
  const ship = buildRun({ ...base, kind: 'ship', stages, now: new Date('2026-10-20T10:40:00Z'), usage: null, grade: 'ready' });
  assert.deepEqual(ship.tokens, { input: null, output: null, cacheRead: null, cacheWrite: null, subagents: null });
  assert.equal(ship.usd, null);
  assert.equal(ship.seconds, 2400);
  assert.deepEqual(ship.outcome, { grade: 'ready', fixRunsBefore: 0, reviewVerdict: null, stoppedAt: null, readyAt: null, mergedAt: null, closedAt: null });
  const file = path.join(tempDir('rj-'), 'docs/pipeline/12/run.json');
  appendRun(file, ship);
  const usage = { tokens: { input: 1000, output: 2000, cacheRead: 7000, cacheWrite: 0, subagents: 500 }, contextPeak: 8000, pausesOverCacheTtl: 0, usd: 1.25, usdSubagents: 0.1, models: ['claude-sonnet-5-5'] };
  const fix = buildRun({ ...base, kind: 'fix', fixRunsBefore: 0, stages: [{ stage: 'fix', at: '2026-10-20T12:00:00Z', model: 'sonnet', effort: 'medium' }], now: new Date('2026-10-20T12:20:00Z'), usage, reviewVerdict: 'revision-needed' });
  const data = appendRun(file, fix);
  assert.deepEqual(data.runs.map((r) => r.kind), ['ship', 'fix']);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), data);
  assert.equal(summaryLine(data), '2 runs (1 ship, 1 fix), 60 min, 10k tokens (70% cache reads), $1.25, cost not reported for 1 run');
  assert.equal(summaryLine({ runs: [fix] }), '1 run (0 ship, 1 fix), 20 min, 10k tokens (70% cache reads), $1.25');
  assert.equal(summaryLine({ runs: [] }), null);
});

test('summaryLine with a reported run first and an unreported one after totals only the reported run', () => {
  const base = { key: '12', runId: 'r', lane: 'github', mode: 'auto', pluginVersion: '0.3.0', sessionEffort: 'default', size: { files: 1, lines: 1, testFiles: 0 }, fixRunsBefore: 0 };
  const usage = { tokens: { input: 1000, output: 2000, cacheRead: 7000, cacheWrite: 0, subagents: 0 }, contextPeak: 1, pausesOverCacheTtl: 0, usd: 1.25, usdSubagents: 0, models: ['m'] };
  const reported = buildRun({ ...base, kind: 'ship', stages: [{ stage: '0', at: '2026-10-20T10:00:00Z', model: 'haiku', effort: 'low' }], now: new Date('2026-10-20T10:30:00Z'), usage });
  const unreported = buildRun({ ...base, kind: 'fix', stages: [{ stage: 'fix', at: '2026-10-20T11:00:00Z', model: 'sonnet', effort: 'medium' }], now: new Date('2026-10-20T11:30:00Z'), usage: null });
  assert.equal(summaryLine({ runs: [reported, unreported] }), '2 runs (1 ship, 1 fix), 60 min, 10k tokens (70% cache reads), $1.25, cost not reported for 1 run');
  assert.equal(summaryLine({ runs: [unreported, reported] }), '2 runs (1 ship, 1 fix), 60 min, 10k tokens (70% cache reads), $1.25, cost not reported for 1 run');
  assert.equal(summaryLine({ runs: [unreported] }), '1 run (0 ship, 1 fix), 30 min, cost not reported for 1 run');
});

test('buildRun with no stage marks starts at the finish and lasts zero seconds', () => {
  const run = buildRun({ key: '1', runId: 'r', lane: 'github', mode: 'auto', kind: 'ship', pluginVersion: '0.3.0', sessionEffort: 'default', stages: [], now: new Date('2026-10-20T10:40:00.700Z'), usage: null, fixRunsBefore: 0, size: { files: 0, lines: 0, testFiles: 0 } });
  assert.deepEqual([run.startedAt, run.finishedAt, run.seconds, run.stages], ['2026-10-20T10:40:00Z', '2026-10-20T10:40:00Z', 0, []]);
});

test('appendRun refuses a run.json it cannot read and leaves the file as it was', () => {
  const dir = tempDir('rj-');
  const run = { kind: 'ship' };
  for (const content of ['{"version":1,"runs":[', '[]', 'null', '{"version":1}', '{"version":1,"runs":{}}']) {
    const file = path.join(dir, 'run.json');
    writeFileSync(file, content);
    assert.throws(() => appendRun(file, run), /run\.json/, content);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});

test('loadUsage is null without session.json, with an unreadable one, or when no transcript exists', () => {
  const runDir = tempDir('run-');
  assert.equal(loadUsage(runDir, {}), null);
  writeFileSync(path.join(runDir, 'session.json'), '{ torn');
  assert.equal(loadUsage(runDir, {}), null);
  writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ sessions: [{ sessionId: 's', transcriptPath: path.join(runDir, 'gone.jsonl') }] }));
  assert.equal(loadUsage(runDir, {}), null);
  writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ sessions: [null, { sessionId: 's' }] }));
  assert.equal(loadUsage(runDir, {}), null);
});

function changedRepo() {
  const { root } = makeRepoWithOrigin({ 'src/a.ts': 'export const a = 1;\n' });
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  writeFiles(root, { 'src/a.ts': 'export const a = 2;\n', 'src/a.test.ts': 'test\n', 'docs/pipeline/12/spec.md': 'spec\n' });
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'change']);
  return { root, base };
}

const recordArgs = (runDir, root, base, extra = []) => ['run-record', '--run-dir', runDir, '--out', 'docs/pipeline/12/run.json', '--key', '12', '--kind', 'ship', '--lane', 'github', '--mode', 'auto', '--base', base, '--cwd', root, '--now', '2026-10-20T10:30:00Z', ...extra];

test('CLI stage-mark and run-record write run.json from the marks, the transcript and the diff', () => {
  const { root, base } = changedRepo();
  const runDir = path.join(tempDir('home-'), 'runs', 'run-T3st');
  mkdirSync(runDir, { recursive: true });
  const transcript = path.join(tempDir('tr-'), 's1.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:05:00Z', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`);
  writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ sessions: [{ sessionId: 's1', transcriptPath: transcript, firstSeen: '2026-10-20T10:00:00Z' }] }));
  assert.equal(runCli(['stage-mark', '--run-dir', runDir, '--stage', '0', '--now', '2026-10-20T10:00:00Z']).code, 0);
  assert.equal(runCli(['stage-mark', '--run-dir', runDir, '--stage', 'nine']).code, 2);
  writeFileSync(path.join(runDir, 'grade.json'), JSON.stringify({ verdict: 'small-gaps' }));
  const r = runCli(['run-record', '--run-dir', runDir, '--out', 'docs/pipeline/12/run.json', '--key', '12', '--kind', 'ship', '--lane', 'github', '--mode', 'auto', '--base', base, '--cwd', root, '--grade-file', path.join(runDir, 'grade.json'), '--now', '2026-10-20T10:30:00Z'], { env: { CLAUDE_PIPELINE_EFFORT: 'high', GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  const run = JSON.parse(readFileSync(path.join(root, 'docs/pipeline/12/run.json'), 'utf8')).runs[0];
  assert.equal(run.runId, 'run-T3st');
  assert.equal(run.sessionEffort, 'high');
  assert.equal(run.outcome.grade, 'small-gaps');
  assert.deepEqual(run.size, { files: 2, lines: 3, testFiles: 1 });
  assert.equal(run.tokens.output, 20);
  assert.equal(run.seconds, 1800);
  assert.match(r.json().summary, /^1 run \(1 ship, 0 fix\), 30 min/);
  assert.deepEqual(runCli(['run-summary', '--file', path.join(root, 'nope.json')]).json(), { summary: null });
  assert.match(runCli(['run-summary', '--file', path.join(root, 'docs/pipeline/12/run.json')]).json().summary, /^1 run/);
});

test('CLI run-record without session.json still writes the run, with null usage', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const r = runCli(recordArgs(runDir, root, base), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  const run = JSON.parse(readFileSync(path.join(root, 'docs/pipeline/12/run.json'), 'utf8')).runs[0];
  assert.equal(run.tokens.output, null);
  assert.equal(run.usd, null);
  assert.deepEqual(run.stages, []);
  assert.equal(run.seconds, 0);
  assert.match(r.json().summary, /cost not reported for 1 run$/);
});

test('CLI run-record with a transcript that is gone writes null usage', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ sessions: [{ sessionId: 's1', transcriptPath: path.join(runDir, 'gone.jsonl'), firstSeen: '2026-10-20T10:00:00Z' }] }));
  const r = runCli(recordArgs(runDir, root, base), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'docs/pipeline/12/run.json'), 'utf8')).runs[0].tokens.input, null);
});

test('CLI run-record counts earlier fix runs and refuses a malformed run.json without touching it', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const env = { GITHUB_RUN_ID: '' };
  assert.equal(runCli(recordArgs(runDir, root, base, ['--kind', 'fix']), { env }).code, 0);
  assert.equal(runCli(recordArgs(runDir, root, base), { env }).code, 0);
  const file = path.join(root, 'docs/pipeline/12/run.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).runs.map((x) => x.outcome.fixRunsBefore), [0, 1]);
  writeFileSync(file, '{"version":1,"runs":[');
  const bad = runCli(recordArgs(runDir, root, base), { env });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /run\.json/);
  assert.equal(readFileSync(file, 'utf8'), '{"version":1,"runs":[');
});

test('CLI run-record refuses an --out outside --cwd and a bad --now', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const outside = path.join(tempDir('out-'), 'run.json');
  const args = recordArgs(runDir, root, base);
  const withOut = (out) => args.map((a, i) => (args[i - 1] === '--out' ? out : a));
  for (const out of [outside, '../escape.json', 'docs/../../escape.json']) {
    const r = runCli(withOut(out));
    assert.equal(r.code, 2, out);
    assert.match(r.stderr, /--out must be inside --cwd/);
  }
  assert.equal(runCli(withOut(path.join(root, 'docs/pipeline/12/run.json'))).code, 0);
  assert.equal(runCli(recordArgs(runDir, root, base, ['--now', 'soon'])).code, 2);
  assert.equal(runCli(['stage-mark', '--run-dir', runDir, '--stage', '0', '--now', 'soon']).code, 2);
});
