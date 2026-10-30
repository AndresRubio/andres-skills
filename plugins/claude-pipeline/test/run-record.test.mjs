import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renameSync as renameSyncReal } from 'node:fs';
import { isIsoDate } from '../skills/ship/scripts/lib/commands.mjs';
import { STAGE_POLICY, stageMark, readStages, stageTimings, buildRun, appendRun, tempPathFor, summaryLine, loadUsage } from '../skills/ship/scripts/lib/run-record.mjs';
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
  const lines = readFileSync(new URL('../skills/ship/SKILL.md', import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## Model policy'));
  assert.ok(start >= 0, 'SKILL.md has a Model policy section');
  const afterHeader = lines.slice(start + 1);
  const sep = afterHeader.findIndex((l) => /^\|[\s|:-]+\|\s*$/.test(l));
  assert.ok(sep >= 0, 'the section has a table');
  const rows = [];
  for (const l of afterHeader.slice(sep + 1)) {
    if (!l.startsWith('|')) break;
    rows.push(l.split('|').slice(1, -1).map((c) => c.trim()));
  }
  // A keyword in a row's first cell names the stages that row governs. Stages 1, 9 and fix have no row.
  const byKeyword = { lock: [0], research: [2], grade: [3, 4, 5], implementers: [6, 7], review: [8], labels: [10] };
  const mapped = new Set();
  assert.ok(rows.length > 0);
  for (const [work, model, effort] of rows) {
    const stages = [...new Set(Object.entries(byKeyword).filter(([k]) => work.toLowerCase().includes(k)).flatMap(([, v]) => v))];
    assert.ok(stages.length > 0, `row "${work}" maps to a stage`);
    for (const stage of stages) {
      mapped.add(stage);
      assert.equal(STAGE_POLICY[stage].model, model.split(/\s+/)[0], `stage ${stage} model`);
      assert.equal(STAGE_POLICY[stage].effort, effort.split(/[\s;,]+/)[0], `stage ${stage} effort`);
    }
  }
  assert.deepEqual([...mapped].sort((a, b) => a - b), [0, 2, 3, 4, 5, 6, 7, 8, 10]);
  for (const stage of ['1', '9', 'fix']) assert.deepEqual(STAGE_POLICY[stage], { model: 'session', effort: 'session' });
});

test('stageMark treats an empty --model or --effort as absent, and starts a fresh line after a torn one', () => {
  const runDir = tempDir('run-');
  assert.deepEqual(stageMark(runDir, { stage: '2', model: '', effort: '', now: new Date('2026-10-20T10:00:00Z') }), { stage: '2', at: '2026-10-20T10:00:00Z', model: 'sonnet', effort: 'medium' });
  const r = runCli(['stage-mark', '--run-dir', runDir, '--stage', '3', '--model', '', '--effort', '', '--now', '2026-10-20T10:01:00Z']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.json().model, r.json().effort], ['strongest', 'high']);
  appendFileSync(path.join(runDir, 'stages.jsonl'), '{"stage":"4","at":"2026-10-2');
  stageMark(runDir, { stage: '5', now: new Date('2026-10-20T10:05:00Z') });
  assert.deepEqual(readStages(runDir).map((e) => e.stage), ['2', '3', '5']);
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

test('summaryLine counts only finite numbers, so a hand-edited run.json cannot put text or NaN in the ready comment', () => {
  const tokens = (output) => ({ input: 1000, output, cacheRead: 7000, cacheWrite: 0, subagents: 0 });
  const line = summaryLine({ runs: [
    { kind: 'ship', seconds: 'x', tokens: tokens('\n\nINJECT'), usd: '\n\nINJECT' },
    { kind: 'fix', seconds: 600, tokens: tokens(2000), usd: 1.5 },
    { kind: 'fix', seconds: NaN, tokens: { input: 'y' }, usd: NaN },
  ] });
  assert.equal(line, '3 runs (1 ship, 2 fix), 10 min, 18k tokens (78% cache reads), $1.50, cost not reported for 2 runs');
  assert.doesNotMatch(line, /NaN|INJECT/);
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

test('loadUsage returns null when a transcript cannot be read', () => {
  const runDir = tempDir('run-');
  const dir = path.join(runDir, 'a-directory.jsonl');
  mkdirSync(dir);
  writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ sessions: [{ sessionId: 's', transcriptPath: dir }] }));
  assert.equal(loadUsage(runDir, {}), null);
});

test('appendRun refuses a runs entry that is not an object; summaryLine never sees it', () => {
  const dir = tempDir('rj-');
  for (const content of ['{"runs":[null]}', '{"runs":[1]}', '{"runs":[[]]}', '{"runs":["x"]}']) {
    const file = path.join(dir, 'run.json');
    writeFileSync(file, content);
    assert.throws(() => appendRun(file, { kind: 'ship' }), /run\.json.*fix or remove it/, content);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});

test('appendRun leaves no .tmp file and replaces the entry of a retried run', () => {
  const dir = tempDir('rj-');
  const file = path.join(dir, 'x', 'run.json');
  const ship = { runId: 'run-a', kind: 'ship', n: 1 };
  appendRun(file, ship);
  assert.deepEqual(readdirSync(path.dirname(file)), ['run.json']);
  assert.deepEqual(appendRun(file, { ...ship, n: 2 }).runs, [{ ...ship, n: 2 }]);
  assert.equal(appendRun(file, { runId: 'run-a', kind: 'fix' }).runs.length, 2);
  assert.equal(appendRun(file, { runId: 'run-b', kind: 'fix' }).runs.length, 3);
  assert.deepEqual(readdirSync(path.dirname(file)), ['run.json']);
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

test('CLI run-record with a missing grade or verdict file records null and names the file on stderr', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const grade = path.join(runDir, 'grade.json');
  const verdict = path.join(runDir, 'verdict.json');
  const r = runCli(recordArgs(runDir, root, base, ['--grade-file', grade, '--verdict-file', verdict]), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  const run = JSON.parse(readFileSync(path.join(root, 'docs/pipeline/12/run.json'), 'utf8')).runs[0];
  assert.equal(run.outcome.grade, null);
  assert.equal(run.outcome.reviewVerdict, null);
  assert.ok(r.stderr.includes(grade), r.stderr);
  assert.ok(r.stderr.includes(verdict), r.stderr);
});

test('CLI run-record with a grade file that exists but does not parse still exits 1', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  writeFileSync(path.join(runDir, 'grade.json'), '{"verdict": ');
  const r = runCli(recordArgs(runDir, root, base, ['--grade-file', path.join(runDir, 'grade.json')]), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 1);
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

test('CLI run-record never aborts on an unreadable transcript', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const dir = path.join(runDir, 'a-directory.jsonl');
  mkdirSync(dir);
  writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ sessions: [{ sessionId: 's1', transcriptPath: dir, firstSeen: '2026-10-20T10:00:00Z' }] }));
  const r = runCli(recordArgs(runDir, root, base), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'docs/pipeline/12/run.json'), 'utf8')).runs[0].usd, null);
});

test('CLI run-record and run-summary refuse a run.json whose runs hold a null, and leave it alone', () => {
  const { root, base } = changedRepo();
  const file = path.join(root, 'docs/pipeline/12/run.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"version":1,"runs":[null]}');
  const record = runCli(recordArgs(tempDir('run-'), root, base), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(record.code, 1);
  assert.match(record.stderr, /docs\/pipeline\/12\/run\.json.*fix or remove it/);
  const summary = runCli(['run-summary', '--file', file]);
  assert.equal(summary.code, 1);
  assert.match(summary.stderr, /run\.json.*fix or remove it/);
  assert.equal(readFileSync(file, 'utf8'), '{"version":1,"runs":[null]}');
});

test('CLI run-record refuses an --out that leaves --cwd through a symlinked directory', () => {
  const made = makeRepoWithOrigin({ 'src/a.ts': 'export const a = 1;\n' });
  // The real path of the repo (/private/var on macOS), so the dangling link below is refused by the
  // unresolvable-link branch alone and not by a /var versus /private/var mismatch.
  const root = realpathSync(made.root);
  const { base } = made;
  const outside = tempDir('outside-');
  symlinkSync(outside, path.join(root, 'docs'), 'dir');
  const dangling = path.join(tempDir('gone-'), 'missing');
  symlinkSync(dangling, path.join(root, 'ghost'), 'dir');
  const runDir = tempDir('run-');
  const env = { GITHUB_RUN_ID: '' };
  for (const out of ['docs/pipeline/12/run.json', 'docs/run.json', 'ghost/run.json']) {
    const args = recordArgs(runDir, root, base);
    const r = runCli(args.map((a, i) => (args[i - 1] === '--out' ? out : a)), { env });
    assert.equal(r.code, 2, out);
    assert.match(r.stderr, /--out must be inside --cwd/);
  }
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readdirSync(path.dirname(dangling)).length, 0);
});

test('CLI run-record accepts a directory whose name starts with two dots', () => {
  const { root, base } = changedRepo();
  const args = recordArgs(tempDir('run-'), root, base);
  const r = runCli(args.map((a, i) => (args[i - 1] === '--out' ? '..foo/run.json' : a)), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(root, '..foo/run.json'), 'utf8')).runs.length, 1);
});

test('CLI run-record twice for one run dir gives one run; a different kind appends; a fix retry does not count itself', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const env = { GITHUB_RUN_ID: '' };
  const file = path.join(root, 'docs/pipeline/12/run.json');
  const runs = () => JSON.parse(readFileSync(file, 'utf8')).runs;
  assert.equal(runCli(recordArgs(runDir, root, base), { env }).code, 0);
  assert.equal(runCli(recordArgs(runDir, root, base), { env }).code, 0);
  assert.deepEqual(runs().map((r) => r.kind), ['ship']);
  assert.equal(runCli(recordArgs(runDir, root, base, ['--kind', 'fix']), { env }).code, 0);
  assert.equal(runCli(recordArgs(runDir, root, base, ['--kind', 'fix']), { env }).code, 0);
  assert.deepEqual(runs().map((r) => [r.kind, r.outcome.fixRunsBefore]), [['ship', 0], ['fix', 0]]);
  assert.deepEqual(readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), []);
});

// --- run.json is written through a temp file in the run dir and never through a link in the repo

const OUTSIDE_BODY = 'outside the worktree, must stay as it is\n';
function outsideFile() {
  const file = path.join(tempDir('outside-'), 'victim.txt');
  writeFileSync(file, OUTSIDE_BODY);
  return file;
}
const noTmp = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

test('CLI run-record with run.json.tmp committed as a symlink exits 1 and writes nothing outside the worktree', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const victim = outsideFile();
  const out = path.join(root, 'docs/pipeline/12/run.json');
  symlinkSync(victim, `${out}.tmp`);
  const r = runCli(recordArgs(runDir, root, base), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /run\.json\.tmp is a symlink/);
  assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_BODY);
  assert.deepEqual(noTmp(runDir), []);
  assert.throws(() => readFileSync(out), /ENOENT/, 'no run.json was written either');
});

test('appendRun without a tmpDir refuses a run.json.tmp that is a symlink, dangling or not, and leaves the target alone', () => {
  for (const make of [() => outsideFile(), () => path.join(tempDir('gone-'), 'missing')]) {
    const dir = tempDir('rj-');
    const file = path.join(dir, 'run.json');
    const victim = make();
    symlinkSync(victim, `${file}.tmp`);
    assert.throws(() => appendRun(file, { runId: 'a', kind: 'ship' }), /run\.json\.tmp is a symlink/);
    assert.ok(lstatSync(`${file}.tmp`).isSymbolicLink());
    assert.throws(() => readFileSync(file), /ENOENT/);
    if (victim.endsWith('victim.txt')) assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_BODY);
    else assert.throws(() => lstatSync(victim), /ENOENT/, 'the dangling target was not created');
  }
});

test('appendRun without a tmpDir replaces a regular leftover .tmp and removes it after the rename', () => {
  const dir = tempDir('rj-');
  const file = path.join(dir, 'run.json');
  writeFileSync(`${file}.tmp`, 'torn');
  appendRun(file, { runId: 'a', kind: 'ship' });
  assert.deepEqual(readdirSync(dir), ['run.json']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).runs.length, 1);
});

test('CLI run-record refuses an --out that is itself a symlink and writes nothing through it', () => {
  const { root, base } = changedRepo();
  // The link stays inside the repo, so the --out path check passes and the symlink refusal is what stops it.
  const victim = path.join(root, 'src', 'victim.json');
  const body = '{"version":1,"runs":[]}\n';
  writeFileSync(victim, body);
  const out = path.join(root, 'docs/pipeline/12/run.json');
  mkdirSync(path.dirname(out), { recursive: true });
  symlinkSync(victim, out);
  const runDir = tempDir('run-');
  const r = runCli(recordArgs(runDir, root, base), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /docs\/pipeline\/12\/run\.json is a symlink/);
  assert.equal(readFileSync(victim, 'utf8'), body);
  assert.ok(lstatSync(out).isSymbolicLink());
  assert.deepEqual(noTmp(runDir), []);
  assert.deepEqual(noTmp(path.dirname(out)), []);
  assert.throws(() => appendRun(out, { runId: 'a', kind: 'ship' }, { tmpDir: runDir }), /is a symlink/);
  // A link that leaves the repo is refused earlier by the --out check.
  const away = path.join(root, 'docs/pipeline/13/run.json');
  mkdirSync(path.dirname(away), { recursive: true });
  const farFile = outsideFile();
  symlinkSync(farFile, away);
  const args = recordArgs(runDir, root, base);
  assert.equal(runCli(args.map((a, i) => (args[i - 1] === '--out' ? 'docs/pipeline/13/run.json' : a)), { env: { GITHUB_RUN_ID: '' } }).code, 2);
  assert.equal(readFileSync(farFile, 'utf8'), OUTSIDE_BODY);
});

test('appendRun writes only { version, runs }: unknown top-level keys of a hand-edited run.json are dropped', () => {
  const dir = tempDir('rj-');
  const file = path.join(dir, 'run.json');
  writeFileSync(file, JSON.stringify({ version: 7, evil: 'x', runs: [{ runId: 'a', kind: 'ship' }], __proto__x: 1 }));
  const data = appendRun(file, { runId: 'b', kind: 'fix' });
  assert.deepEqual(Object.keys(data), ['version', 'runs']);
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk), ['version', 'runs']);
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.runs.length, 2);
});

test('CLI run-record leaves no .tmp in the run dir or beside run.json', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  assert.equal(runCli(recordArgs(runDir, root, base), { env: { GITHUB_RUN_ID: '' } }).code, 0);
  assert.deepEqual(noTmp(runDir), []);
  assert.deepEqual(noTmp(path.join(root, 'docs/pipeline/12')), []);
});

test('appendRun replaces run.json by rename: a hard link to the old file keeps the old content and the inode changes', () => {
  for (const withTmpDir of [false, true]) {
    const dir = tempDir('rj-');
    const tmpDir = tempDir('tmp-');
    const file = path.join(dir, 'run.json');
    appendRun(file, { runId: 'a', kind: 'ship' }, withTmpDir ? { tmpDir } : {});
    const before = readFileSync(file, 'utf8');
    const inode = statSync(file).ino;
    linkSync(file, path.join(dir, 'old-link'));
    appendRun(file, { runId: 'b', kind: 'fix' }, withTmpDir ? { tmpDir } : {});
    // An in-place writeFileSync would rewrite the shared inode, so the link would show the new content.
    assert.equal(readFileSync(path.join(dir, 'old-link'), 'utf8'), before, `tmpDir ${withTmpDir}`);
    assert.notEqual(statSync(file).ino, inode);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).runs.length, 2);
  }
});

test('appendRun puts the temp file in tmpDir, outside the target directory, and falls back beside the target on another device or EXDEV', () => {
  const dir = tempDir('rj-');
  const tmpDir = tempDir('tmp-');
  const file = path.join(dir, 'run.json');
  const seen = [];
  const rename = (from, to) => { seen.push(from); renameSyncReal(from, to); };
  appendRun(file, { runId: 'a', kind: 'ship' }, { tmpDir, rename });
  assert.deepEqual(seen, [path.join(tmpDir, 'run.json.tmp')]);
  // Different devices: the chooser puts the temp file beside the target.
  const dev = (p) => (p === tmpDir ? 1 : 2);
  assert.equal(tempPathFor(file, tmpDir, dev), `${file}.tmp`);
  assert.equal(tempPathFor(file, tmpDir, () => 5), path.join(tmpDir, 'run.json.tmp'));
  assert.equal(tempPathFor(file, undefined), `${file}.tmp`);
  assert.equal(tempPathFor(file, path.join(tmpDir, 'missing')), `${file}.tmp`);
  // The devices look equal but the kernel says EXDEV: write again beside the target and clean both.
  const calls = [];
  const exdev = (from, to) => {
    calls.push(from);
    if (from.startsWith(tmpDir)) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    renameSyncReal(from, to);
  };
  const data = appendRun(file, { runId: 'b', kind: 'fix' }, { tmpDir, rename: exdev });
  assert.deepEqual(calls, [path.join(tmpDir, 'run.json.tmp'), `${file}.tmp`]);
  assert.equal(data.runs.length, 2);
  assert.deepEqual(noTmp(dir), []);
  assert.deepEqual(noTmp(tmpDir), []);
  // Any other rename failure is thrown, and no temp file stays behind.
  assert.throws(() => appendRun(file, { runId: 'c', kind: 'fix' }, { tmpDir, rename: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } }), /nope/);
  assert.deepEqual(noTmp(tmpDir), []);
});

test('buildRun records the models that had no price and a run.json entry keeps the documented key order', () => {
  const base = { key: '1', runId: 'r', lane: 'github', mode: 'auto', kind: 'ship', pluginVersion: '0.3.0', sessionEffort: 'default', stages: [], now: new Date('2026-10-20T10:40:00Z'), fixRunsBefore: 0, size: { files: 0, lines: 0, testFiles: 0 } };
  const usage = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, subagents: 0 }, contextPeak: 5, pausesOverCacheTtl: 0, usd: null, usdSubagents: null, models: ['claude-new', 'claude-sonnet-5-5'], unpriced: ['claude-new'] };
  const run = buildRun({ ...base, usage });
  assert.deepEqual(run.unpriced, ['claude-new']);
  assert.deepEqual(Object.keys(run), ['key', 'runId', 'lane', 'mode', 'kind', 'pluginVersion', 'sessionEffort', 'stages', 'startedAt', 'finishedAt', 'seconds', 'tokens', 'contextPeak', 'pausesOverCacheTtl', 'usd', 'usdSubagents', 'models', 'unpriced', 'outcome', 'size', 'scores']);
  assert.deepEqual(buildRun({ ...base, usage: null }).unpriced, []);
  assert.deepEqual(buildRun({ ...base, usage: { ...usage, unpriced: undefined } }).unpriced, []);
});

test('buildRun never finishes before its last stage mark, so startedAt does not exceed finishedAt', () => {
  const base = { key: '1', runId: 'r', lane: 'github', mode: 'auto', kind: 'ship', pluginVersion: '0.3.0', sessionEffort: 'default', usage: null, fixRunsBefore: 0, size: { files: 0, lines: 0, testFiles: 0 } };
  const stages = [{ stage: '0', at: '2026-10-20T10:00:00Z', model: 'haiku', effort: 'low' }, { stage: '3', at: '2026-10-20T11:00:00Z', model: 'strongest', effort: 'high' }];
  const run = buildRun({ ...base, stages, now: new Date('2026-10-20T10:30:00Z') });
  assert.equal(run.finishedAt, '2026-10-20T11:00:00Z');
  assert.ok(Date.parse(run.startedAt) <= Date.parse(run.finishedAt));
  assert.deepEqual(run.stages.map((s) => s.seconds), [3600, 0]);
  assert.equal(run.seconds, 3600);
  // A mark before now leaves finishedAt at now.
  assert.equal(buildRun({ ...base, stages, now: new Date('2026-10-20T12:00:00Z') }).finishedAt, '2026-10-20T12:00:00Z');
  // The same through the CLI with --now before the mark.
  const { root, base: ref } = changedRepo();
  const runDir = tempDir('run-');
  stageMark(runDir, { stage: '0', now: new Date('2026-10-20T11:00:00Z') });
  const r = runCli(recordArgs(runDir, root, ref), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  const rec = JSON.parse(readFileSync(path.join(root, 'docs/pipeline/12/run.json'), 'utf8')).runs[0];
  assert.deepEqual([rec.startedAt, rec.finishedAt, rec.seconds], ['2026-10-20T11:00:00Z', '2026-10-20T11:00:00Z', 0]);
});

// --- grade and verdict files

test('CLI run-record warns about a missing grade or verdict file with one JSON line per file on stderr', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const grade = path.join(runDir, 'grade.json');
  const verdict = path.join(runDir, 'verdict.json');
  const r = runCli(recordArgs(runDir, root, base, ['--grade-file', grade, '--verdict-file', verdict]), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stderr.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ warning: `${grade} not found, recorded null` }, { warning: `${verdict} not found, recorded null` }]);
});

test('CLI run-record with a directory as --grade-file exits 1: only ENOENT means missing', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  const dir = path.join(runDir, 'grade.json');
  mkdirSync(dir);
  const r = runCli(recordArgs(runDir, root, base, ['--grade-file', dir]), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EISDIR/);
  assert.throws(() => readFileSync(path.join(root, 'docs/pipeline/12/run.json')), /ENOENT/);
});

test('CLI run-record with a grade or verdict file that is not a JSON object exits 1 and names the file', () => {
  const { root, base } = changedRepo();
  const runDir = tempDir('run-');
  for (const content of ['{"verdict": ', '[]', 'null', '7', '"ready"', '']) {
    const file = path.join(runDir, 'g.json');
    writeFileSync(file, content);
    for (const flag of ['--grade-file', '--verdict-file']) {
      const r = runCli(recordArgs(runDir, root, base, [flag, file]), { env: { GITHUB_RUN_ID: '' } });
      assert.equal(r.code, 1, `${flag} ${content}`);
      assert.equal(JSON.parse(r.stderr.trim().split('\n').at(-1)).error, `${file} is not a JSON object with a verdict`);
    }
  }
  // An object without a verdict key still reads as null.
  const file = path.join(runDir, 'ok.json');
  writeFileSync(file, '{}');
  assert.equal(runCli(recordArgs(runDir, root, base, ['--grade-file', file]), { env: { GITHUB_RUN_ID: '' } }).code, 0);
});

// --- metrics --since

test('metrics --since takes a full ISO date or date-time and refuses what Date.parse alone would take', () => {
  for (const since of ['5', '2026', '2026-10', 'Oct 5 2026', '2026-10-05T', '2026-13-45', '2026-10-05T10:00', '']) {
    const r = runCli(['metrics', '--repo', 'o/r', '--since', since]);
    assert.equal(r.code, 2, `--since ${JSON.stringify(since)}: ${r.stderr}`);
    assert.match(r.stderr, /--since must be an ISO date/);
  }
  for (const since of ['2026-10-05', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00.250Z', '2026-10-05T10:00:00+02:00']) assert.equal(isIsoDate(since), true, since);
  for (const since of ['5', '2026', '2026-13-45', '2026-10-05T10:00:00']) assert.equal(isIsoDate(since), false, since);
});

test('appendRun refuses a symlink where the temp file would go in tmpDir, and never follows it', () => {
  const dir = tempDir('rj-');
  const tmpDir = tempDir('tmp-');
  const file = path.join(dir, 'run.json');
  const victim = outsideFile();
  symlinkSync(victim, path.join(tmpDir, 'run.json.tmp'));
  assert.throws(() => appendRun(file, { runId: 'a', kind: 'ship' }, { tmpDir }), /run\.json\.tmp is a symlink/);
  assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_BODY);
  assert.deepEqual(readdirSync(dir), []);
  // A regular leftover in tmpDir is replaced.
  const other = tempDir('tmp-');
  writeFileSync(path.join(other, 'run.json.tmp'), 'torn');
  appendRun(file, { runId: 'a', kind: 'ship' }, { tmpDir: other });
  assert.deepEqual(readdirSync(other), []);
});

test('CLI run-record writes its temp file in --run-dir: a regular run.json.tmp in the repo is left untouched', () => {
  const { root, base } = changedRepo();
  const out = path.join(root, 'docs/pipeline/12/run.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, 'keep');
  const r = runCli(recordArgs(tempDir('run-'), root, base), { env: { GITHUB_RUN_ID: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(`${out}.tmp`, 'utf8'), 'keep');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).runs.length, 1);
});
