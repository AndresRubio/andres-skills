import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseSource } from './source.mjs';
import { branchName, keyFromBranch, worktreePath } from './naming.mjs';
import { loadConfig } from './config.mjs';
import { formatMarker, parseMarker, defaultRun } from './marker.mjs';
import { lockStatus } from './lock.mjs';
import { checkEligibility, LANES } from './eligibility.mjs';
import { fetchIssue, currentRepo, countOpenClaudePrs, ghJson } from './github.mjs';
import { gradeVerdict } from './grade.mjs';
import { findFreePort, diffSize } from './runtime.mjs';
import { takeScreenshot } from './chrome.mjs';
import { startPreview, stopPreview } from './preview.mjs';
import { createWorktree, isolateInPlace, removeWorktreeIfEmpty } from './worktree.mjs';

export class UsageError extends Error {}

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

const PLUGIN_JSON = new URL('../../../../.claude-plugin/plugin.json', import.meta.url);

export const COMMANDS = {
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
  'pr-count': (argv) => {
    const v = parse(argv, { repo: { type: 'string' } });
    const repo = v.repo ?? currentRepo();
    return { count: countOpenClaudePrs(ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'headRefName,isCrossRepository'])) };
  },
  eligibility: (argv) => {
    const v = parse(argv, {
      'issue-file': { type: 'string' }, 'config-file': { type: 'string' }, lane: { type: 'string' },
      'open-claude-prs': { type: 'string' }, now: { type: 'string' },
    });
    required(v, 'issue-file', 'config-file', 'lane');
    if (!LANES.includes(v.lane)) throw new UsageError(`--lane must be one of ${LANES.join(', ')}`);
    if (v['open-claude-prs'] !== undefined && !/^\d+$/.test(v['open-claude-prs'])) {
      throw new UsageError('--open-claude-prs must be an integer >= 0');
    }
    return checkEligibility({
      issue: readJson(v['issue-file']),
      config: readJson(v['config-file']),
      lane: v.lane,
      openClaudePrs: v['open-claude-prs'] !== undefined ? Number(v['open-claude-prs']) : 0,
      now: v.now ? new Date(v.now) : new Date(),
    });
  },
  grade: (argv) => {
    const v = parse(argv, { 'checklist-file': { type: 'string' }, 'config-file': { type: 'string' }, mode: { type: 'string' } });
    required(v, 'checklist-file', 'config-file', 'mode');
    if (!['auto', 'interactive'].includes(v.mode)) throw new UsageError('--mode must be auto or interactive');
    return gradeVerdict(readJson(v['checklist-file']), { maxPrSize: readJson(v['config-file']).maxPrSize, mode: v.mode });
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
