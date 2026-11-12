import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseSource } from './source.mjs';
import { branchName, keyFromBranch, worktreePath } from './naming.mjs';
import { loadConfig } from './config.mjs';
import { formatMarker, parseMarker, defaultRun } from './marker.mjs';
import { lockStatus } from './lock.mjs';
import { checkEligibility, LANES } from './eligibility.mjs';
import { ghJson, ghText, isRepoSlug, fetchIssue, fetchPr, currentRepo, fetchActiveRuns, fetchPrComments, postPrComment, postIssueComment } from './github.mjs';
import { computeVerdict, formatVerdictBody, latestVerdict } from './verdict.mjs';
import { waitingFor, KEY_RE } from './runs.mjs';
import { gradeVerdict } from './grade.mjs';
import { findFreePort, diffSize } from './runtime.mjs';
import { takeScreenshot } from './chrome.mjs';
import { startPreview, stopPreview } from './preview.mjs';
import { createWorktree, isolateInPlace, removeWorktreeIfEmpty } from './worktree.mjs';
import { diffRisk } from './diff-risk.mjs';
import { revertCheck, changedTestFiles } from './revert-check.mjs';
import { STAGE_POLICY, stageMark, readStages, stageTimings, loadUsage, buildRun, appendRun, refuseSymlink, readRunFile, sameRun, summaryLine } from './run-record.mjs';
import { runReady } from './ready-run.mjs';
import { runSweep, realSweepDeps } from './sweep-run.mjs';
import { laneTarget } from './lane.mjs';
import { sessionStarted, notStartedBody, holdsLock, stoppedBody } from './ship-status.mjs';
import { defaultVars, installFiles } from './setup.mjs';
import { formatScoreBody } from './score.mjs';
import { hydrate } from './hydrate-run.mjs';
import { aggregate, formatTable } from './metrics.mjs';
import { collectRows } from './metrics-run.mjs';

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

// A resumed run never regrades, so a missing grade or verdict file reads as null with one JSON line on
// stderr. Only ENOENT counts as missing. A file that exists but is not a JSON object with a verdict key
// reads as an error (exit 1).
function readVerdictFile(file) {
  if (!file) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error(`${file} cannot be read: ${err?.message ?? err}`);
    process.stderr.write(`${JSON.stringify({ warning: `${file} not found, recorded null` })}\n`);
    return null;
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object with a verdict`);
  return data.verdict ?? null;
}

// A full ISO 8601 date or date-time. Date.parse alone takes '5' or '2026'.
export const isIsoDate = (text) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(text) && Number.isFinite(Date.parse(text));

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
  const raw = env.ISSUE_PIPELINE_RECOUNT_DELAY_MS;
  if (raw === undefined || raw === '') return 5000;
  if (!/^\d+$/.test(raw)) throw new UsageError('ISSUE_PIPELINE_RECOUNT_DELAY_MS must be an integer >= 0');
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

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// The path with symlinks resolved through its deepest existing ancestor; the parts below that do not
// exist yet, so they cannot be links. A link that does not resolve (dangling, a loop) is refused.
function realTarget(target) {
  const rest = [];
  let at = target;
  for (;;) {
    try {
      lstatSync(at);
      break;
    } catch {
      const up = path.dirname(at);
      if (up === at) return null;
      rest.unshift(path.basename(at));
      at = up;
    }
  }
  try {
    return path.join(realpathSync(at), ...rest);
  } catch {
    return null;
  }
}

function nowOption(value) {
  if (value === undefined) return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new UsageError('--now must be an ISO date');
  return d;
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
      // A cancelled or superseded review must not post "did not complete" for a head nobody needs.
      if (fetchPr(v.repo, prNumber(v.pr)).headRefOid !== head) throw new ExitError({ verdict: 'human-decision-needed', source: 'stale' });
      const marker = formatMarker('verdict');
      postPrComment(v.repo, prNumber(v.pr), formatVerdictBody({ verdict: 'human-decision-needed', head, findings: [], diffRisk: [], reason: 'review did not complete', marker }));
      throw new ExitError({ verdict: 'human-decision-needed', source: 'posted' });
    }
    throw new ExitError({ verdict: 'human-decision-needed', source: 'missing' });
  },
  // After the Claude step of pipeline-ship: did the session start, and did it end properly? A session
  // can end as a success having done nothing, or having taken the lock and stopped. With
  // --post-missing, either case gets a `blocked` comment and `needs-decision` on the issue and exit 1,
  // so the owner hears about it and the sweep stops starting the issue again; a held lock is released
  // too. A fix run keyed by its pull request has no issue to park and nothing sweeps it, so only its
  // run folder is checked.
  'ship-status': (argv) => {
    const v = parse(argv, { home: { type: 'string' }, repo: { type: 'string' }, key: { type: 'string' }, 'post-missing': { type: 'boolean' } });
    required(v, 'home', 'key');
    if (!KEY_RE.test(v.key)) throw new UsageError('--key must be a run key: an issue number or PR-<n>');
    const folder = sessionStarted(v.home);
    if (!v['post-missing'] || !/^\d+$/.test(v.key)) {
      if (!folder) throw new ExitError({ started: false, source: 'missing' });
      return { started: true };
    }
    required(v, 'repo');
    if (!isRepoSlug(v.repo)) throw new UsageError(`--repo must be owner/name, got ${JSON.stringify(v.repo)}`);
    const run = defaultRun();
    const comments = fetchPrComments(v.repo, v.key);
    const park = (body) => {
      postIssueComment(v.repo, v.key, body);
      ghText(['issue', 'edit', v.key, '--repo', v.repo, '--add-label', 'needs-decision']);
    };
    // The run folder is looked for where the workflow says the home is. A run that commented on the
    // issue started, wherever its folder went, so it is never told that it did not.
    if (!folder && !comments.some((c) => c.pipeline && c.marker.run === run)) {
      park(notStartedBody(formatMarker('blocked', { run }), run));
      throw new ExitError({ started: false, source: 'posted' });
    }
    const labels = ghJson(['issue', 'view', v.key, '--repo', v.repo, '--json', 'labels']).labels.map((l) => l.name);
    if (holdsLock(run, { labels, comments })) {
      park(stoppedBody(formatMarker('blocked', { run }), run));
      ghText(['issue', 'edit', v.key, '--repo', v.repo, '--remove-label', 'pipeline-working']);
      throw new ExitError({ started: true, finished: false, source: 'posted' });
    }
    return { started: true };
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
  score: (argv) => {
    const v = parse(argv, { head: { type: 'string' }, 'score-file': { type: 'string' }, model: { type: 'string' }, run: { type: 'string' }, now: { type: 'string' } });
    required(v, 'head', 'score-file');
    const head = headSha(v.head);
    const marker = formatMarker('score', { run: v.run ?? defaultRun(), now: v.now ? new Date(v.now) : new Date() });
    return { body: formatScoreBody({ marker, head, score: readJson(v['score-file']), model: v.model ?? null }) };
  },
  sweep: (argv) => {
    const v = parse(argv, { repo: { type: 'string' }, 'repo-root': { type: 'string' }, 'dry-run': { type: 'boolean' }, now: { type: 'string' } });
    required(v, 'repo', 'repo-root');
    if (v.now !== undefined && Number.isNaN(new Date(v.now).getTime())) throw new UsageError('--now must be an ISO date');
    // Reads .claude/pipeline.json from the default branch (origin/HEAD), as ready does.
    const result = runSweep({ config: loadConfig(v['repo-root']), now: v.now ? new Date(v.now) : new Date(), dryRun: Boolean(v['dry-run']) }, realSweepDeps(v.repo));
    if (result.errors.length) throw new ExitError(result);
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
  'stage-mark': (argv) => {
    const v = parse(argv, { 'run-dir': { type: 'string' }, stage: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, now: { type: 'string' } });
    required(v, 'run-dir', 'stage');
    if (!Object.hasOwn(STAGE_POLICY, v.stage)) throw new UsageError(`--stage must be one of ${Object.keys(STAGE_POLICY).join(', ')}`);
    return stageMark(v['run-dir'], { stage: v.stage, model: v.model, effort: v.effort, now: nowOption(v.now) });
  },
  'run-record': (argv) => {
    const v = parse(argv, {
      'run-dir': { type: 'string' }, out: { type: 'string' }, key: { type: 'string' }, kind: { type: 'string' }, lane: { type: 'string' },
      mode: { type: 'string' }, base: { type: 'string' }, cwd: { type: 'string' }, 'grade-file': { type: 'string' },
      'verdict-file': { type: 'string' }, 'stopped-at': { type: 'string' }, now: { type: 'string' },
    });
    required(v, 'run-dir', 'out', 'key', 'kind', 'lane', 'mode', 'base');
    if (!['ship', 'fix'].includes(v.kind)) throw new UsageError('--kind must be ship or fix');
    if (!LANES.includes(v.lane)) throw new UsageError(`--lane must be one of ${LANES.join(', ')}`);
    if (!['auto', 'interactive'].includes(v.mode)) throw new UsageError('--mode must be auto or interactive');
    const now = nowOption(v.now);
    const cwd = v.cwd ?? process.cwd();
    const out = path.resolve(cwd, v.out);
    // run.json is committed with the change, so it belongs inside the repository being recorded.
    // No component between --cwd and --out may be a symlink: a link out of the repo would write outside it,
    // and a link to another directory inside the repo would rewrite that directory's run.json and leave
    // `git add` refusing a path beyond a symbolic link. So the real path of --out must be the real path of
    // --cwd plus the relative path as given.
    const absCwd = path.resolve(cwd);
    const realOut = realTarget(out);
    const realCwd = realTarget(absCwd);
    if (!isInside(absCwd, out) || realOut === null || realCwd === null || !isInside(realCwd, realOut)) throw new UsageError('--out must be inside --cwd');
    refuseSymlink(out);
    if (realOut !== path.join(realCwd, path.relative(absCwd, out))) throw new UsageError('--out must be inside --cwd and reached without a symlinked directory');
    const stages = readStages(v['run-dir']);
    const runId = process.env.GITHUB_RUN_ID ? defaultRun() : path.basename(v['run-dir']);
    // A retry of the same run replaces its entry (appendRun), so it must not count itself as an earlier run.
    const recorded = readRunFile(out).runs;
    const earlier = sameRun(recorded.at(-1), { runId, kind: v.kind }) ? recorded.slice(0, -1) : recorded;
    const run = buildRun({
      key: v.key, kind: v.kind, lane: v.lane, mode: v.mode, runId,
      pluginVersion: readJson(PLUGIN_JSON).version,
      sessionEffort: process.env.ISSUE_PIPELINE_EFFORT || 'default',
      stages, now,
      usage: loadUsage(v['run-dir'], { from: stageTimings(stages, now)[0]?.startedAt, to: now.toISOString() }),
      grade: readVerdictFile(v['grade-file']),
      fixRunsBefore: earlier.filter((r) => r.kind === 'fix').length,
      reviewVerdict: readVerdictFile(v['verdict-file']),
      stoppedAt: v['stopped-at'] ?? null,
      size: { ...diffSize(cwd, v.base), testFiles: changedTestFiles(cwd, v.base).length },
    });
    return { file: out, summary: summaryLine(appendRun(out, run, { tmpDir: v['run-dir'] })) };
  },
  metrics: (argv) => {
    const v = parse(argv, { repo: { type: 'string', multiple: true }, since: { type: 'string' }, table: { type: 'boolean' } });
    if (v.since !== undefined && !isIsoDate(v.since)) throw new UsageError('--since must be an ISO date');
    const bad = (v.repo ?? []).find((r) => !isRepoSlug(r));
    if (bad !== undefined) throw new UsageError(`--repo must be owner/name, got ${JSON.stringify(bad)}`);
    const repos = v.repo?.length ? v.repo : [currentRepo()];
    const results = repos.map((repo) => ({ repo, since: v.since ?? null, ...aggregate(collectRows(repo, { since: v.since })) }));
    return v.table ? results.map((r) => formatTable(r.repo, r)).join('\n\n') : { repos: results };
  },
  'run-summary': (argv) => {
    const v = parse(argv, { file: { type: 'string' } });
    required(v, 'file');
    return { summary: existsSync(v.file) ? summaryLine(readRunFile(v.file)) : null };
  },
  hydrate: async (argv) => {
    const v = parse(argv, { 'issue-file': { type: 'string' }, 'config-file': { type: 'string' }, out: { type: 'string' }, repo: { type: 'string' } });
    required(v, 'issue-file', 'config-file', 'out');
    const issue = readJson(v['issue-file']);
    const repo = v.repo ?? String(issue.url ?? '').match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1];
    if (!repo) throw new UsageError('--repo is required when the issue file has no GitHub issue URL');
    return await hydrate({ issue, repo, config: readJson(v['config-file']), outDir: v.out });
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
