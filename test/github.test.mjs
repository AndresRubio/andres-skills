import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as github from '../skills/ship/scripts/lib/github.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { runCli } from './helpers/cli.mjs';
import { tempDir } from './helpers/git.mjs';

const { normalizeIssue, fetchActiveRuns } = github;

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('normalizeIssue flattens labels, parses markers and keeps only open relations', () => {
  const issue = normalizeIssue(fixture('gh-issue.json'), fixture('gh-comments.json').flat(), {
    blockedBy: [{ number: 3, state: 'open' }, { number: 2, state: 'closed' }],
    subIssues: [{ number: 8, state: 'closed' }],
  });
  assert.equal(issue.number, 5);
  assert.equal(issue.id, 3001);
  assert.equal(issue.author, 'AndresRubio');
  assert.equal(issue.authorAssociation, 'OWNER');
  assert.equal(issue.isPullRequest, false);
  assert.deepEqual(issue.labels, ['claude', 'enhancement']);
  assert.deepEqual(issue.openBlockedBy, [3]);
  assert.deepEqual(issue.openSubIssues, []);
  assert.equal(issue.comments.length, 2);
  assert.equal(issue.comments[0].marker.kind, 'lock');
  assert.equal(issue.comments[1].marker, null);
  assert.equal(issue.comments[1].authorAssociation, 'NONE');
});

test('normalizeIssue sets pipeline and trusted on each comment', () => {
  const comment = (over) => ({ id: 1, user: { login: 'x' }, author_association: 'NONE', body: 'hi', created_at: 't', ...over });
  const marker = (kind = 'lock') => `**[claude-pipeline]** ${kind} · 2026-09-25T10:00:00Z · local`;

  const ownerMarker = normalizeIssue(fixture('gh-issue.json'), [comment({ user: { login: 'AndresRubio' }, author_association: 'OWNER', body: marker() })]);
  assert.deepEqual([ownerMarker.comments[0].pipeline, ownerMarker.comments[0].trusted], [true, true]);

  const noneMarker = normalizeIssue(fixture('gh-issue.json'), [comment({ author_association: 'NONE', body: marker() })]);
  assert.deepEqual([noneMarker.comments[0].pipeline, noneMarker.comments[0].trusted], [false, false]);

  const botMarker = normalizeIssue(fixture('gh-issue.json'), [comment({ user: { login: 'claude[bot]' }, author_association: 'NONE', body: marker() })]);
  assert.equal(botMarker.comments[0].pipeline, true);

  const ownerNoMarker = normalizeIssue(fixture('gh-issue.json'), [comment({ user: { login: 'AndresRubio' }, author_association: 'OWNER', body: 'just a note' })]);
  assert.deepEqual([ownerNoMarker.comments[0].pipeline, ownerNoMarker.comments[0].trusted], [false, true]);
});

test('CLI issue calls gh and prints the normalized issue', () => {
  const dir = fakeGh({
    'repo view --json nameWithOwner': { nameWithOwner: 'o/r' },
    'api repos/o/r/issues/5': fixture('gh-issue.json'),
    'api --paginate --slurp repos/o/r/issues/5/comments': fixture('gh-comments.json'),
    'api repos/o/r/issues/5/dependencies/blocked_by': [{ number: 3, state: 'open' }],
    'api repos/o/r/issues/5/sub_issues': [],
  });
  const r = runCli(['issue', '5'], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json().openBlockedBy, [3]);
  assert.equal(r.json().comments[0].marker.kind, 'lock');
});

test('CLI issue fails loudly when gh fails', () => {
  const dir = fakeGh({ 'repo view --json nameWithOwner': { nameWithOwner: 'o/r' } });
  const r = runCli(['issue', '5'], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"error"/);
});

// --- D16: runs in progress ---

const REPO = 'o/r';
const NOW_ISO = '2026-10-06T12:00:00Z';
const PR_LIST = `pr list --repo ${REPO} --state open --limit 500 --json number,headRefName,isCrossRepository,title`;
const ISSUE_LIST = `issue list --repo ${REPO} --state open --label claude-working --limit 500 --json number`;
const apiIssue = (number, over = {}) => ({
  number, id: 1000 + number, node_id: `I_${number}`, title: `Issue ${number}`, body: `Body of ${number}`, state: 'open',
  html_url: `https://github.com/${REPO}/issues/${number}`, user: { login: 'AndresRubio' }, author_association: 'OWNER',
  labels: [{ name: 'claude' }, { name: 'claude-working' }], ...over,
});
const apiLock = (id, createdAt, branch) => ({
  id, user: { login: 'AndresRubio' }, author_association: 'OWNER', created_at: createdAt,
  body: `**[claude-pipeline]** lock · ${createdAt} · local\n\nRun started — lane github, mode auto, branch \`${branch}\`.`,
});
const issueRoutes = (number, comments, over = {}) => ({
  [`api repos/${REPO}/issues/${number}`]: apiIssue(number, over),
  [`api --paginate --slurp repos/${REPO}/issues/${number}/comments`]: [comments],
  [`api repos/${REPO}/issues/${number}/dependencies/blocked_by`]: [],
  [`api repos/${REPO}/issues/${number}/sub_issues`]: [],
});
const runsRoutes = ({ selfComments = [apiLock(951, '2026-10-06T11:30:00Z', 'claude/5-self')] } = {}) => ({
  [PR_LIST]: [
    { number: 40, headRefName: 'claude/7-a', isCrossRepository: false, title: 'Seven' },
    { number: 41, headRefName: 'claude/6-fork', isCrossRepository: true, title: 'Fork' },
  ],
  [ISSUE_LIST]: [{ number: 5 }, { number: 8 }, { number: 9 }],
  ...issueRoutes(8, [apiLock(801, '2026-10-06T11:00:00Z', 'claude/8-x')]),
  ...issueRoutes(9, [apiLock(901, '2026-10-06T05:00:00Z', 'claude/9-x')]),
  ...issueRoutes(5, selfComments),
});
const EXPECTED_RUNS = {
  self: { key: '5', lockedAt: '2026-10-06T11:30:00Z', lockId: 951 },
  runs: [
    { key: '7', issue: 7, pr: 40, branch: 'claude/7-a', title: 'Seven', body: null, textWithheld: false, lockedAt: null, lockId: null, related: false },
    { key: '8', issue: 8, pr: null, branch: 'claude/8-x', title: 'Issue 8', body: 'Body of 8', textWithheld: false, lockedAt: '2026-10-06T11:00:00Z', lockId: 801, related: false },
  ],
  ahead: ['7', '8'],
  maxParallel: 2,
  admitted: false,
};
const configFile = () => {
  const file = path.join(tempDir(), 'config.json');
  writeFileSync(file, JSON.stringify(validateConfig({ tracker: { type: 'github' } })));
  return file;
};
// Wraps the fake gh so each call is appended to a log file, to count the fetches.
function loggingGh(routes) {
  const fake = fakeGh(routes);
  const dir = tempDir('logging-gh-');
  const log = path.join(dir, 'calls.log');
  writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${path.join(fake, 'gh')}' "$@"\n`, { mode: 0o755 });
  return { dir, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

test('countOpenClaudePrs is gone', () => {
  assert.equal('countOpenClaudePrs' in github, false);
});

test('fetchActiveRuns lists PRs and claude-working issues, fetches each other issue, then self', () => {
  const routes = runsRoutes();
  const calls = [];
  const gh = (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (!(key in routes)) throw new Error(`no route for ${key}`);
    return structuredClone(routes[key]);
  };
  const r = fetchActiveRuns(REPO, 5, { ttlHours: 3, maxParallel: 2, now: new Date(NOW_ISO) }, gh);
  assert.deepEqual(r, EXPECTED_RUNS);
  const fetches = (n) => [
    `api repos/${REPO}/issues/${n}`, `api --paginate --slurp repos/${REPO}/issues/${n}/comments`,
    `api repos/${REPO}/issues/${n}/dependencies/blocked_by`, `api repos/${REPO}/issues/${n}/sub_issues`,
  ];
  assert.deepEqual(calls, [PR_LIST, ISSUE_LIST, ...fetches(8), ...fetches(9), ...fetches(5)]);
  assert.equal(fetchActiveRuns(REPO, 5, { ttlHours: 3, maxParallel: 3, now: new Date(NOW_ISO) }, gh).admitted, true);
});

test('CLI active-runs prints the runs in progress, with ttlHours and maxParallel from the config', () => {
  const dir = fakeGh(runsRoutes());
  const r = runCli(['active-runs', '--repo', REPO, '--issue', '5', '--config-file', configFile(), '--now', NOW_ISO], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), EXPECTED_RUNS);
  const missing = runCli(['active-runs', '--repo', REPO, '--config-file', configFile()], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(missing.code, 2);
  const bad = runCli(['active-runs', '--repo', REPO, '--issue', 'five', '--config-file', configFile()], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(bad.code, 2);
});

test('CLI active-runs --expect-locked exits 1 after one retry when its own lock is not visible', () => {
  const { dir, calls } = loggingGh(runsRoutes({ selfComments: [] }));
  const r = runCli(['active-runs', '--repo', REPO, '--issue', '5', '--config-file', configFile(), '--now', NOW_ISO, '--expect-locked'], {
    env: { PATH: `${dir}:${process.env.PATH}`, CLAUDE_PIPELINE_RECOUNT_DELAY_MS: '0' },
  });
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stderr), { error: "this run's own lock isn't visible: read lag, or the run outlived lockTtlHours" });
  assert.equal(calls().filter((c) => c === PR_LIST).length, 2);
});

test('CLI active-runs --expect-locked does not retry when its own lock is visible; without the flag an unlocked count is fine', () => {
  const locked = loggingGh(runsRoutes());
  const r = runCli(['active-runs', '--repo', REPO, '--issue', '5', '--config-file', configFile(), '--now', NOW_ISO, '--expect-locked'], {
    env: { PATH: `${locked.dir}:${process.env.PATH}`, CLAUDE_PIPELINE_RECOUNT_DELAY_MS: '0' },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), EXPECTED_RUNS);
  assert.equal(locked.calls().filter((c) => c === PR_LIST).length, 1);

  const dir = fakeGh(runsRoutes({ selfComments: [] }));
  const before = runCli(['active-runs', '--repo', REPO, '--issue', '5', '--config-file', configFile(), '--now', NOW_ISO], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(before.code, 0, before.stderr);
  assert.deepEqual(before.json().self, { key: '5', lockedAt: null, lockId: null });
  assert.deepEqual(before.json().ahead, ['7', '8']);
});

test('CLI waiting-for reads the wait from an issue file', () => {
  const file = path.join(tempDir(), 'issue.json');
  const at = '2026-10-06T11:00:00Z';
  const wait = { id: 77, user: { login: 'claude[bot]' }, author_association: 'NONE', created_at: at, body: `**[claude-pipeline]** deferred · ${at} · local\n\n**Verdict:** \`wait\`\n\nWaiting for: 7, 8` };
  writeFileSync(file, JSON.stringify(normalizeIssue(apiIssue(5), [wait])));
  const r = runCli(['waiting-for', '--issue-file', file]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { waitingFor: ['7', '8'] });
  assert.equal(runCli(['waiting-for']).code, 2);
});

test('pr-count is now an unknown command', () => {
  const r = runCli(['pr-count', '--repo', REPO]);
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.stderr).error, /unknown command "pr-count"/);
});
