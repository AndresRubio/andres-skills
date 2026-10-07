import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseSource } from './source.mjs';
import { branchName, keyFromBranch, worktreePath } from './naming.mjs';
import { loadConfig } from './config.mjs';
import { formatMarker, parseMarker, defaultRun } from './marker.mjs';
import { lockStatus } from './lock.mjs';
import { checkEligibility, LANES } from './eligibility.mjs';
import { ghJson, fetchIssue, currentRepo, fetchActiveRuns, fetchPrComments, postPrComment } from './github.mjs';
import { computeVerdict, formatVerdictBody, latestVerdict } from './verdict.mjs';
import { waitingFor, KEY_RE } from './runs.mjs';
import { gradeVerdict } from './grade.mjs';
import { findFreePort, diffSize } from './runtime.mjs';
import { takeScreenshot } from './chrome.mjs';
import { startPreview, stopPreview } from './preview.mjs';
import { createWorktree, isolateInPlace, removeWorktreeIfEmpty } from './worktree.mjs';
import { diffRisk } from './diff-risk.mjs';
import { revertCheck } from './revert-check.mjs';
import { runReady } from './ready-run.mjs';
import { laneTarget } from './lane.mjs';
import { defaultVars, installFiles } from './setup.mjs';

export class UsageError extends Error {}

// Carries a result object that the CLI prints on stdout before exiting 1 (verdict-status).
export class ExitError extends Error {
  constructor(result) {
    super('exit');
    this.result = result;
  }
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function parse(argv, options = {}, positionals = 0) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (parsed.positionals.length !== positionals) {
    throw new UsageError(`expected ${positionals} positional argument(s), got ${parsed.positionals.length}`);
  }
  return { ...parsed.values, _: parsed.positionals };
}

export function required(values, ...names) {
  for (const name of names) {
    if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  }
}

// How long active-runs --expect-locked and waiting-for --expect wait before their one retry.
function recountDelayMs(env = process.env) {
  const raw = env.CLAUDE_PIPELINE_RECOUNT_DELAY_MS;
  if (raw === undefined || raw === '') return 5000;
  if (!/^\d+$/.test(raw)) throw new UsageError('CLAUDE_PIPELINE_RECOUNT_DELAY_MS must be an integer >= 0');
  return Number(raw);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function issueNumber(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError('--issue must be a positive integer');
  return Number(value);
}

const SHA_RE = /^[0-9a-f]{40}$/;
function headSha(value) {
  if (!SHA_RE.test(value ?? '')) throw new UsageError('--head must be a 40-character SHA');
  return value;
}
function prNumber(value) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1) throw new UsageError('--pr must be a positive integer');
  return Number(value);
}

const PLUGIN_JSON = new URL('../../../../.claude-plugin/plugin.json', import.meta.url);

export const COMMANDS = {
  verdict: (argv) => {
    const v = parse(argv, { head: { type: 'string' }, 'findings-file': { type: 'string' }, 'diff-risk-file': { type: 'string' }, model: { type: 'string' }, reason: { type: 'string' }, run: { type: 'string' }, now: { type: 'string' } });
    required(v, 'head', 'findings-file');
    const head = headSha(v.head);
    const findings = readJson(v['findings-file']);
    const diffRisk = v['diff-risk-file'] ? (readJson(v['diff-risk-file']).hits ?? []) : [];
    const verdict = v.reason ? 'human-decision-needed' : computeVerdict(findings);
    const marker = formatMarker('verdict', { run: v.run ?? defaultRun(), now: v.now ? new Date(v.now) : new Date() });
    return { verdict, body: formatVerdictBody({ verdict, head, findings, diffRisk, model: v.model ?? null, reason: v.reason ?? null, marker }) };
  },
  'verdict-latest': (argv) => {
    const v = parse(argv, { repo: { type: 'string' }, pr: { type: 'string' }, head: { type: 'string' } });
    required(v, 'repo', 'pr', 'head');
    return latestVerdict(fetchPrComments(v.repo, prNumber(v.pr)), headSha(v.head)) ?? { verdict: null };
  },
  'verdict-status': (argv) => {
    const v = parse(argv, { repo: { type: 'string' }, pr: { type: 'string' }, head: { type: 'string' }, 'post-missing': { type: 'boolean' } });
    required(v, 'repo', 'pr', 'head');
    const head = headSha(v.head);
    const found = latestVerdict(fetchPrComments(v.repo, prNumber(v.pr)), head);
    if (found) {
      const result = { verdict: found.verdict, source: 'comment' };
      if (found.verdict !== 'accepted') throw new ExitError(result);
      return result;
    }
    if (v['post-missing']) {
      const marker = formatMarker('verdict');
      postPrComment(v.repo, prNumber(v.pr), formatVerdictBody({ verdict: 'human-decision-needed', head, findings: [], diffRisk: [], reason: 'review did not complete', marker }));
      throw new ExitError({ verdict: 'human-decision-needed', source: 'posted' });
    }
    throw new ExitError({ verdict: 'human-decision-needed', source: 'missing' });
  },
  version: (argv) => {
    parse(argv);
    return { version: readJson(PLUGIN_JSON).version };
  },
  source: (argv) => parseSource(parse(argv, {}, 1)._[0]),
  'branch-name': (argv) => {
    const v = parse(argv, { key: { type: 'string' }, title: { type: 'string' }, 'issue-file': { type: 'string' } });
    required(v, 'key');
    if ((v.title !== undefined) === (v['issue-file'] !== undefined)) {
      throw new UsageError('exactly one of --title or --issue-file is required');
    }
    let title = v.title;
    if (v['issue-file'] !== undefined) {
      const issue = readJson(v['issue-file']);
      if (typeof issue.title !== 'string') throw new Error(`${v['issue-file']} has no string "title" field`);
      title = issue.title;
    }
    return { branch: branchName(v.key, title) };
  },
  'key-from-branch': (argv) => ({ key: keyFromBranch(parse(argv, {}, 1)._[0]) }),
  'worktree-path': (argv) => {
    const v = parse(argv, { 'repo-root': { type: 'string' }, key: { type: 'string' } });
    required(v, 'repo-root', 'key');
    return { path: worktreePath(v['repo-root'], v.key) };
  },
  setup: (argv) => {
    const v = parse(argv, { 'repo-root': { type: 'string' }, 'plugin-repo': { type: 'string' }, 'plugin-ref': { type: 'string' }, 'plugin-subdir': { type: 'string' }, marketplace: { type: 'string' }, 'ci-workflows': { type: 'string' }, force: { type: 'boolean' } });
    required(v, 'repo-root');
    const vars = defaultVars({
      ciWorkflows: v['ci-workflows'] ? v['ci-workflows'].split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      pluginRepo: v['plugin-repo'], pluginRef: v['plugin-ref'], pluginSubdir: v['plugin-subdir'], marketplace: v.marketplace,
    });
    return { vars, ...installFiles(v['repo-root'], vars, { force: Boolean(v.force) }) };
  },
  config: (argv) => {
    const v = parse(argv, { 'repo-root': { type: 'string' }, ref: { type: 'string' } });
    return loadConfig(v['repo-root'] ?? process.cwd(), { ref: v.ref });
  },
  marker: (argv) => {
    const v = parse(argv, { run: { type: 'string' }, now: { type: 'string' } }, 1);
    return formatMarker(v._[0], { run: v.run ?? defaultRun(), now: v.now ? new Date(v.now) : new Date() });
  },
  'parse-marker': (argv) => {
    parse(argv);
    return parseMarker(readFileSync(0, 'utf8'));
  },
  'lock-status': (argv) => {
    const v = parse(argv, { 'issue-file': { type: 'string' }, 'ttl-hours': { type: 'string' }, now: { type: 'string' } });
    required(v, 'issue-file', 'ttl-hours');
    return lockStatus(readJson(v['issue-file']), { ttlHours: Number(v['ttl-hours']), now: v.now ? new Date(v.now) : new Date() });
  },
  issue: (argv) => {
    const v = parse(argv, { repo: { type: 'string' } }, 1);
    const number = Number(v._[0]);
    if (!Number.isInteger(number) || number < 1) throw new UsageError('issue number must be a positive integer');
    return fetchIssue(v.repo ?? currentRepo(), number);
  },
  'active-runs': async (argv) => {
    const v = parse(argv, {
      repo: { type: 'string' }, issue: { type: 'string' }, 'config-file': { type: 'string' },
      now: { type: 'string' }, 'expect-locked': { type: 'boolean' },
    });
    required(v, 'repo', 'issue', 'config-file');
    const number = issueNumber(v.issue);
    if (v.now !== undefined && Number.isNaN(new Date(v.now).getTime())) throw new UsageError('--now must be an ISO date');
    const delayMs = v['expect-locked'] ? recountDelayMs() : 0;
    const { lockTtlHours, maxParallel } = readJson(v['config-file']);
    if (!(typeof lockTtlHours === 'number' && lockTtlHours > 0) || !(Number.isInteger(maxParallel) && maxParallel >= 1)) {
      throw new Error(`${v['config-file']} has no valid lockTtlHours and maxParallel; write it with the config command`);
    }
    const count = () => fetchActiveRuns(v.repo, number, { ttlHours: lockTtlHours, maxParallel, now: v.now ? new Date(v.now) : new Date() });
    let runs = count();
    if (v['expect-locked'] && runs.self.lockedAt === null) {
      await sleep(delayMs);
      runs = count();
      if (runs.self.lockedAt === null) throw new Error("this run's own lock isn't visible: read lag, or the run outlived lockTtlHours");
    }
    return runs;
  },
  // Two modes: --issue-file reads a saved issue; --repo --issue --expect fetches the issue and
  // checks that the wait just posted reads back as the expected keys, retrying once for read lag.
  'waiting-for': async (argv) => {
    const v = parse(argv, {
      'issue-file': { type: 'string' }, repo: { type: 'string' }, issue: { type: 'string' }, expect: { type: 'string' },
    });
    const fetchMode = ['repo', 'issue', 'expect'].filter((name) => v[name] !== undefined);
    if (v['issue-file'] !== undefined) {
      if (fetchMode.length) throw new UsageError('use either --issue-file, or --repo with --issue and --expect');
      return { waitingFor: waitingFor(readJson(v['issue-file'])) };
    }
    required(v, 'repo', 'issue', 'expect');
    const number = issueNumber(v.issue);
    const expected = v.expect.split(',').map((key) => key.trim());
    if (!expected.every((key) => KEY_RE.test(key))) throw new UsageError('--expect must be run keys joined by ","');
    const delayMs = recountDelayMs();
    const same = (keys) => keys.length === new Set(expected).size && keys.every((key) => expected.includes(key));
    let keys = waitingFor(fetchIssue(v.repo, number));
    if (!same(keys)) {
      await sleep(delayMs);
      keys = waitingFor(fetchIssue(v.repo, number));
      if (!same(keys)) {
        throw new Error(`the posted wait doesn't read back: expected ${expected.join(', ')}, got ${keys.length ? keys.join(', ') : 'none'}`);
      }
    }
    return { waitingFor: keys };
  },
  eligibility: (argv) => {
    const v = parse(argv, {
      'issue-file': { type: 'string' }, 'config-file': { type: 'string' }, lane: { type: 'string' },
      'active-runs-file': { type: 'string' }, now: { type: 'string' },
    });
    required(v, 'issue-file', 'config-file', 'lane');
    if (!LANES.includes(v.lane)) throw new UsageError(`--lane must be one of ${LANES.join(', ')}`);
    if (v.lane !== 'manual') required(v, 'active-runs-file');
    return checkEligibility({
      issue: readJson(v['issue-file']),
      config: readJson(v['config-file']),
      lane: v.lane,
      activeRuns: v['active-runs-file'] !== undefined ? readJson(v['active-runs-file']) : undefined,
      now: v.now ? new Date(v.now) : new Date(),
    });
  },
  grade: (argv) => {
    const v = parse(argv, {
      'checklist-file': { type: 'string' }, 'config-file': { type: 'string' }, mode: { type: 'string' },
      'active-runs-file': { type: 'string' },
    });
    required(v, 'checklist-file', 'config-file', 'mode');
    if (!['auto', 'interactive'].includes(v.mode)) throw new UsageError('--mode must be auto or interactive');
    const checklist = readJson(v['checklist-file']);
    if (Array.isArray(checklist?.waitFor) && checklist.waitFor.length && v['active-runs-file'] === undefined) {
      throw new UsageError('--active-runs-file is required when waitFor is not empty');
    }
    return gradeVerdict(checklist, {
      maxPrSize: readJson(v['config-file']).maxPrSize,
      mode: v.mode,
      activeRuns: v['active-runs-file'] !== undefined ? readJson(v['active-runs-file']) : undefined,
    });
  },
  'free-port': async (argv) => {
    const v = parse(argv, { start: { type: 'string' } });
    return { port: await findFreePort(v.start ? Number(v.start) : 5173) };
  },
  'diff-size': (argv) => {
    const v = parse(argv, { base: { type: 'string' }, cwd: { type: 'string' } });
    required(v, 'base');
    return diffSize(v.cwd ?? process.cwd(), v.base);
  },
  'diff-risk': (argv) => {
    const v = parse(argv, { base: { type: 'string' }, cwd: { type: 'string' } });
    required(v, 'base');
    return diffRisk(v.cwd ?? process.cwd(), v.base);
  },
  'revert-check': (argv) => {
    const v = parse(argv, { base: { type: 'string' }, command: { type: 'string' }, cwd: { type: 'string' }, 'timeout-ms': { type: 'string' } });
    required(v, 'base', 'command');
    const timeoutMs = v['timeout-ms'] === undefined ? undefined : Number(v['timeout-ms']);
    if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) throw new UsageError('--timeout-ms must be a positive integer');
    return revertCheck(v.cwd ?? process.cwd(), v.base, { command: v.command, timeoutMs });
  },
  ready: async (argv) => {
    const v = parse(argv, { repo: { type: 'string' }, 'repo-root': { type: 'string' }, 'dry-run': { type: 'boolean' }, now: { type: 'string' } });
    required(v, 'repo', 'repo-root');
    if (v.now !== undefined && Number.isNaN(new Date(v.now).getTime())) throw new UsageError('--now must be an ISO date');
    // Reads .claude/pipeline.json from the default branch (origin/HEAD), never from the PR's head.
    const result = await runReady({ repo: v.repo, config: loadConfig(v['repo-root']), now: v.now ? new Date(v.now) : new Date(), dryRun: Boolean(v['dry-run']) });
    if (result.actions.some((a) => a.action === 'error')) throw new ExitError(result);
    return result;
  },
  'lane-target': (argv) => {
    const v = parse(argv, { 'event-file': { type: 'string' }, 'event-name': { type: 'string' }, repo: { type: 'string' } });
    required(v, 'event-file', 'event-name', 'repo');
    const payload = readJson(v['event-file']);
    const openPrs = v['event-name'] === 'issue_comment'
      ? ghJson(['pr', 'list', '--repo', v.repo, '--state', 'open', '--limit', '500', '--json', 'number,headRefName,isCrossRepository,labels'])
      : [];
    return laneTarget({ name: v['event-name'], payload }, { openPrs });
  },
  screenshot: async (argv) => {
    const v = parse(argv, { url: { type: 'string' }, out: { type: 'string' }, width: { type: 'string' }, height: { type: 'string' } });
    required(v, 'url', 'out');
    return await takeScreenshot(v.url, v.out, { width: Number(v.width ?? 1280), height: Number(v.height ?? 800) });
  },
  'preview-start': async (argv) => {
    const v = parse(argv, {
      'config-file': { type: 'string' }, port: { type: 'string' }, cwd: { type: 'string' },
      log: { type: 'string' }, 'pid-file': { type: 'string' }, 'timeout-ms': { type: 'string' },
    });
    required(v, 'config-file', 'port', 'cwd', 'log', 'pid-file');
    return await startPreview({
      config: readJson(v['config-file']),
      port: Number(v.port),
      cwd: v.cwd,
      logFile: v.log,
      pidFile: v['pid-file'],
      timeoutMs: v['timeout-ms'] !== undefined ? Number(v['timeout-ms']) : undefined,
    });
  },
  'preview-stop': (argv) => {
    const v = parse(argv, { 'pid-file': { type: 'string' } });
    required(v, 'pid-file');
    return stopPreview({ pidFile: v['pid-file'] });
  },
  worktree: (argv) => {
    const v = parse(argv, {
      'repo-root': { type: 'string' }, key: { type: 'string' }, branch: { type: 'string' },
      base: { type: 'string' }, 'in-place': { type: 'boolean' },
    });
    required(v, 'repo-root', 'key', 'branch', 'base');
    if (v['in-place']) return isolateInPlace({ repoRoot: v['repo-root'], branch: v.branch, base: v.base });
    return createWorktree({ repoRoot: v['repo-root'], path: worktreePath(v['repo-root'], v.key), branch: v.branch, base: v.base });
  },
  'worktree-remove-if-empty': (argv) => {
    const v = parse(argv, { 'repo-root': { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' }, base: { type: 'string' } });
    required(v, 'repo-root', 'path', 'branch', 'base');
    return removeWorktreeIfEmpty({ repoRoot: v['repo-root'], path: v.path, branch: v.branch, base: v.base });
  },
};
