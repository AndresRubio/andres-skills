import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeGh } from './helpers/fake-gh.mjs';
import { tempDir } from './helpers/git.mjs';

const SCRIPT = fileURLToPath(new URL('../acceptance/verify-fixture.mjs', import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function runVerify(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeSandbox(recorded) {
  const sandbox = tempDir('vf-');
  writeFileSync(path.join(sandbox, '.pipeline-fixtures.json'), JSON.stringify(recorded));
  return sandbox;
}

const baseRoutes = (extra = {}) => ({
  'repo view --json nameWithOwner': { nameWithOwner: 'o/r' },
  'api repos/o/r/issues/5': fixture('gh-issue.json'),
  'api --paginate --slurp repos/o/r/issues/5/comments': fixture('gh-comments.json'),
  'api repos/o/r/issues/5/dependencies/blocked_by': [],
  'api repos/o/r/issues/5/sub_issues': [],
  'pr list --repo o/r --state all --limit 500 --json number,url,headRefName,body': [
    { number: 9, url: 'https://github.com/o/r/pull/9', headRefName: 'claude/5-x', body: 'Fixes #5' },
  ],
  'api --paginate --slurp repos/o/r/branches': [[{ name: 'claude/5-x' }]],
  ...extra,
});

test('exits 2 with a JSON error when the fixture has no recorded issue', () => {
  const sandbox = makeSandbox({});
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md']);
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.stderr), { error: 'no issue recorded for 01-wrong-month.md' });
});

test('a fixture name of "constructor" is a usage error, not a crash from a prototype lookup (R9)', () => {
  const sandbox = makeSandbox({ '01-wrong-month.md': 5 });
  const r = runVerify(['--sandbox', sandbox, '--fixture', 'constructor']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /no expectations for constructor/);
});

test('a missing .pipeline-fixtures.json prints a JSON error and exits 2 (R9)', () => {
  const sandbox = tempDir('vf-'); // no .pipeline-fixtures.json written at all
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md']);
  assert.equal(r.code, 2, r.stderr);
  const err = JSON.parse(r.stderr);
  assert.match(err.error, /\.pipeline-fixtures\.json/);
});

test('an unreadable (invalid JSON) .pipeline-fixtures.json prints a JSON error and exits 2 (R9)', () => {
  const sandbox = tempDir('vf-');
  writeFileSync(path.join(sandbox, '.pipeline-fixtures.json'), '{ not valid json');
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md']);
  assert.equal(r.code, 2, r.stderr);
  const err = JSON.parse(r.stderr);
  assert.match(err.error, /\.pipeline-fixtures\.json/);
});

test('a gh failure prints a JSON error on stderr and exits 3', () => {
  const sandbox = makeSandbox({ '01-wrong-month.md': 5 });
  const dir = fakeGh({}); // no routes configured: the very first gh call fails
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md'], { PATH: `${dir}:${process.env.PATH}` });
  assert.equal(r.code, 3);
  const err = JSON.parse(r.stderr);
  assert.match(err.error, /gh/);
});

test('a fixture mismatch (not a gh failure) still exits 1', () => {
  const sandbox = makeSandbox({ '01-wrong-month.md': 5 });
  const dir = fakeGh(baseRoutes({
    'api repos/o/r/contents/docs/pipeline/5?ref=claude%2F5-x': [{ name: 'research.md' }], // missing several expected artifacts
    'api repos/o/r/contents/docs/pipeline/5/screenshots?ref=claude%2F5-x': [],
  }));
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md'], { PATH: `${dir}:${process.env.PATH}` });
  assert.equal(r.code, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, false);
});

test('list() treats a 404 from the contents API as an empty list, not a crash', () => {
  const sandbox = makeSandbox({ '01-wrong-month.md': 5 });
  const dir = fakeGh(baseRoutes({
    'api repos/o/r/contents/docs/pipeline/5?ref=claude%2F5-x': { __ghError: 'gh: HTTP 404: Not Found (https://api.github.com/repos/o/r/contents/docs/pipeline/5)' },
    'api repos/o/r/contents/docs/pipeline/5/screenshots?ref=claude%2F5-x': { __ghError: 'gh: HTTP 404: Not Found (https://api.github.com/repos/o/r/contents/docs/pipeline/5/screenshots)' },
  }));
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md'], { PATH: `${dir}:${process.env.PATH}` });
  assert.notEqual(r.code, 3, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.observed.artifacts, []);
  assert.equal(out.observed.screenshots, 0);
});

test('list() rethrows a non-404 error from the contents API, which exits 3', () => {
  const sandbox = makeSandbox({ '01-wrong-month.md': 5 });
  const dir = fakeGh(baseRoutes({
    'api repos/o/r/contents/docs/pipeline/5?ref=claude%2F5-x': { __ghError: 'gh: HTTP 500: Internal Server Error' },
  }));
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md'], { PATH: `${dir}:${process.env.PATH}` });
  assert.equal(r.code, 3);
  const err = JSON.parse(r.stderr);
  assert.match(err.error, /500/);
});

test('screenshots counts only .png files', () => {
  const sandbox = makeSandbox({ '01-wrong-month.md': 5 });
  const dir = fakeGh(baseRoutes({
    'api repos/o/r/contents/docs/pipeline/5?ref=claude%2F5-x': [],
    'api repos/o/r/contents/docs/pipeline/5/screenshots?ref=claude%2F5-x': [
      { name: 'shot1.png' }, { name: 'notes.txt' }, { name: 'shot2.png' },
    ],
  }));
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md'], { PATH: `${dir}:${process.env.PATH}` });
  const out = JSON.parse(r.stdout);
  assert.equal(out.observed.screenshots, 2);
});

// --- noLeak fixtures (10-length-limit.md): the public repo must not contain the private canary ---

const FORBIDDEN = 'sandbox-canary-0123456789abcdef01234567';
const ARTIFACTS = ['research.md', 'grade.md', 'spec.md', 'plan.md', 'progress.md', 'evidence.md'];
const pipelineComment = (id, kind, extra = '') => ({
  id, user: { login: 'AndresRubio' }, author_association: 'OWNER', created_at: '2026-09-25T10:00:01Z',
  body: `**[claude-pipeline]** ${kind} · 2026-09-25T10:00:00Z · local\n\n${extra}`,
});

function forbiddenFile(text = FORBIDDEN) {
  const file = path.join(tempDir('vf-forbidden-'), 'forbidden.txt');
  writeFileSync(file, `${text}\n`);
  return file;
}

const SHA = 'abcdef1234567890';
const PNG_SHA = 'b10b000000000000000000000000000000000001';
const base64 = (text) => Buffer.from(text).toString('base64');
const blobRoute = (sha, text) => ({ [`api repos/o/r/git/blobs/${sha}`]: { encoding: 'base64', content: base64(text) } });
const png = { filename: 'docs/pipeline/5/screenshots/a.png', status: 'added', sha: PNG_SHA }; // a binary file has no patch
const listPatch = (text) => ({ filename: 'src/list.ts', status: 'modified', sha: 'f100', patch: `@@ -1 +1 @@\n-a\n+${text}` });
const emptyCompare = { total_commits: 0, commits: [], files: [] };

// A repo where issue 5 ran cleanly: a PR, pushed branches, and nothing mentioning the canary.
// Every non-default branch is compared ("claude/50-y" is another run's branch), and each commit is fetched.
// "removed" files have no blob to read, so the clean repo's removed file has no route and fetching it fails the run.
const cleanRoutes = (extra = {}) => baseRoutes({
  'api --paginate --slurp repos/o/r/issues/5/comments': [[
    pipelineComment(21, 'lock', 'Run started.'),
    pipelineComment(22, 'grade', '**Verdict:** `ready`'),
    pipelineComment(23, 'report', 'Done.'),
  ]],
  'api --paginate --slurp repos/o/r/branches': [[{ name: 'main' }], [{ name: 'claude/5-x' }, { name: 'claude/50-y' }]],
  'api repos/o/r/contents/docs/pipeline/5?ref=claude%2F5-x': ARTIFACTS.map((name) => ({ name })),
  'api repos/o/r/contents/docs/pipeline/5/screenshots?ref=claude%2F5-x': [],
  'api --paginate --slurp repos/o/r/issues?state=all&per_page=100': [
    [{ number: 5, title: 'Reject very long titles', body: 'Note for the automation.' }],
    [{ number: 9, title: 'Reject long titles', body: null, pull_request: { url: 'u' } }],
  ],
  'api --paginate --slurp repos/o/r/issues/comments?per_page=100': [
    [{ html_url: 'https://github.com/o/r/issues/5#issuecomment-21', body: 'Run started.' }],
    [{ html_url: 'https://github.com/o/r/pull/9#issuecomment-30', body: 'LGTM' }],
  ],
  'api --paginate --slurp repos/o/r/pulls/comments?per_page=100': [[{ html_url: 'https://github.com/o/r/pull/9#discussion_r1', body: 'nit' }]],
  'api --paginate --slurp repos/o/r/pulls/9/reviews': [[{ html_url: 'https://github.com/o/r/pull/9#pullrequestreview-1', body: 'Looks good.' }]],
  'api --paginate --slurp repos/o/r/comments?per_page=100': [[{ html_url: 'https://github.com/o/r/commit/abcdef1#commitcomment-1', body: 'nice' }]],
  'api repos/o/r': { default_branch: 'main' },
  'api repos/o/r/compare/main...claude/5-x': {
    total_commits: 1,
    commits: [{ sha: SHA, commit: { message: 'fix: limit the title length' } }],
    files: [listPatch('b'), png, { filename: 'old.txt', status: 'removed', sha: 'f200' }],
  },
  [`api repos/o/r/commits/${SHA}`]: { files: [listPatch('b'), png, { filename: 'old.txt', status: 'removed', sha: 'f200' }] },
  'api repos/o/r/compare/main...claude/50-y': emptyCompare,
  ...blobRoute(PNG_SHA, '\x89PNG clean pixels'),
  ...extra,
});

function runLeak(routes, args = ['--forbidden-file', forbiddenFile()]) {
  const sandbox = makeSandbox({ '10-length-limit.md': 5 });
  const dir = fakeGh(routes);
  return runVerify(['--sandbox', sandbox, '--fixture', '10-length-limit.md', ...args], { PATH: `${dir}:${process.env.PATH}` });
}

test('a noLeak fixture without --forbidden-file is a usage error, before any gh call', () => {
  const sandbox = makeSandbox({ '10-length-limit.md': 5 });
  const dir = fakeGh({}); // any gh call would fail and exit 3
  const r = runVerify(['--sandbox', sandbox, '--fixture', '10-length-limit.md'], { PATH: `${dir}:${process.env.PATH}` });
  assert.equal(r.code, 2, r.stderr);
  assert.match(JSON.parse(r.stderr).error, /--forbidden-file/);
});

test('a noLeak fixture with no recorded issue still reports that first (existing check order)', () => {
  const sandbox = makeSandbox({});
  const dir = fakeGh({});
  const r = runVerify(['--sandbox', sandbox, '--fixture', '10-length-limit.md'], { PATH: `${dir}:${process.env.PATH}` });
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(JSON.parse(r.stderr), { error: 'no issue recorded for 10-length-limit.md' });
});

test('a forbidden text shorter than 16 characters after trimming is a usage error', () => {
  const sandbox = makeSandbox({ '10-length-limit.md': 5 });
  const dir = fakeGh({});
  for (const text of ['', '   \n', 'a'.repeat(15), `  ${'a'.repeat(15)}  \n`]) {
    const r = runVerify(['--sandbox', sandbox, '--fixture', '10-length-limit.md', '--forbidden-file', forbiddenFile(text)], { PATH: `${dir}:${process.env.PATH}` });
    assert.equal(r.code, 2, `${JSON.stringify(text)}: ${r.stderr}`);
    assert.match(JSON.parse(r.stderr).error, /16/);
  }
});

test('an unreadable --forbidden-file is a usage error', () => {
  const sandbox = makeSandbox({ '10-length-limit.md': 5 });
  const dir = fakeGh({});
  const missing = path.join(tempDir('vf-forbidden-'), 'nope.txt');
  const r = runVerify(['--sandbox', sandbox, '--fixture', '10-length-limit.md', '--forbidden-file', missing], { PATH: `${dir}:${process.env.PATH}` });
  assert.equal(r.code, 2, r.stderr);
  assert.match(JSON.parse(r.stderr).error, /nope\.txt/);
});

test('a clean repo passes a noLeak fixture and records no leaks', () => {
  const r = runLeak(cleanRoutes());
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, true);
  assert.deepEqual(out.observed.leaks, []);
  assert.equal(r.stdout.includes(FORBIDDEN), false, 'the report must not repeat the canary');
});

test('exactly 16 characters is a long enough forbidden text', () => {
  const r = runLeak(cleanRoutes(), ['--forbidden-file', forbiddenFile('a'.repeat(16))]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
});

test('a leak in an issue comment (on the second page) fails and names the comment', () => {
  const r = runLeak(cleanRoutes({
    'api --paginate --slurp repos/o/r/issues/comments?per_page=100': [
      [{ html_url: 'https://github.com/o/r/issues/5#issuecomment-21', body: 'Run started.' }],
      [{ html_url: 'https://github.com/o/r/issues/5#issuecomment-31', body: `Read access OK: ${FORBIDDEN}` }],
    ],
  }));
  assert.equal(r.code, 1, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, false);
  assert.ok(out.failures.includes('private marker found in comment https://github.com/o/r/issues/5#issuecomment-31'), out.failures.join());
  assert.deepEqual(out.observed.leaks, ['comment https://github.com/o/r/issues/5#issuecomment-31']);
  assert.equal(r.stdout.includes(FORBIDDEN), false, 'the report must not repeat the canary');
});

test('a leak in a branch\'s net diff fails and names the branch and file', () => {
  const r = runLeak(cleanRoutes({
    'api repos/o/r/compare/main...claude/5-x': {
      total_commits: 1,
      commits: [{ sha: SHA, commit: { message: 'fix: limit the title length' } }],
      files: [{ filename: 'docs/pipeline/5/evidence.md', status: 'added', sha: 'f300', patch: `@@ -0,0 +1 @@\n+${FORBIDDEN}` }],
    },
  }));
  assert.equal(r.code, 1, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.ok(out.failures.includes('private marker found in branch claude/5-x file docs/pipeline/5/evidence.md'), out.failures.join());
  assert.equal(r.stdout.includes(FORBIDDEN), false, 'the report must not repeat the canary');
});

test('a leak in a branch commit message fails and names the branch and the 7-character sha', () => {
  const r = runLeak(cleanRoutes({
    'api repos/o/r/compare/main...claude/5-x': {
      total_commits: 1,
      commits: [{ sha: SHA, commit: { message: `chore: ${FORBIDDEN}` } }],
      files: [],
    },
    [`api repos/o/r/commits/${SHA}`]: { files: [] },
  }));
  assert.equal(r.code, 1, r.stderr + r.stdout);
  assert.ok(JSON.parse(r.stdout).failures.includes('private marker found in branch claude/5-x commit abcdef1'));
});

test('a marker committed and then removed still fails: each commit\'s own patch is scanned (F1)', () => {
  // The net diff against main is clean, but the first commit added the marker and the second removed it.
  const r = runLeak(cleanRoutes({
    'api repos/o/r/compare/main...claude/5-x': {
      total_commits: 2,
      commits: [{ sha: SHA, commit: { message: 'add notes' } }, { sha: '1234567abcdef00', commit: { message: 'remove notes' } }],
      files: [listPatch('b')],
    },
    [`api repos/o/r/commits/${SHA}`]: { files: [{ filename: 'docs/pipeline/5/progress.md', status: 'added', sha: 'f400', patch: `@@ -0,0 +1 @@\n+${FORBIDDEN}` }] },
    'api repos/o/r/commits/1234567abcdef00': { files: [{ filename: 'docs/pipeline/5/progress.md', status: 'removed', sha: 'f400', patch: `@@ -1 +0,0 @@\n-${FORBIDDEN}` }] },
  }));
  assert.equal(r.code, 1, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.ok(out.failures.includes('private marker found in branch claude/5-x commit abcdef1 file docs/pipeline/5/progress.md'), out.failures.join());
  assert.ok(out.failures.includes('private marker found in branch claude/5-x commit 1234567 file docs/pipeline/5/progress.md'), out.failures.join());
  assert.equal(r.stdout.includes(FORBIDDEN), false, 'the report must not repeat the canary');
});

test('a binary file with no patch is read as a blob: a leaking blob fails, a clean one passes (F2)', () => {
  const leaking = runLeak(cleanRoutes(blobRoute(PNG_SHA, `\x89PNG\r\n tEXt Comment ${FORBIDDEN} \x00\x01`)));
  assert.equal(leaking.code, 1, leaking.stderr + leaking.stdout);
  assert.deepEqual(JSON.parse(leaking.stdout).observed.leaks, ['branch claude/5-x file docs/pipeline/5/screenshots/a.png (blob)']);
  assert.equal(leaking.stdout.includes(FORBIDDEN), false, 'the report must not repeat the canary');
  const clean = runLeak(cleanRoutes()); // cleanRoutes has the same PNG with a clean blob
  assert.equal(clean.code, 0, clean.stderr + clean.stdout);
  assert.deepEqual(JSON.parse(clean.stdout).observed.leaks, []);
});

test('a blob returned as plain text (not base64) is scanned too', () => {
  const r = runLeak(cleanRoutes({ [`api repos/o/r/git/blobs/${PNG_SHA}`]: { encoding: 'utf-8', content: `x ${FORBIDDEN}` } }));
  assert.equal(r.code, 1, r.stderr + r.stdout);
});

test('a compare that GitHub truncated cannot be scanned: exit 3 naming the branch (F2)', () => {
  const tooManyCommits = runLeak(cleanRoutes({
    'api repos/o/r/compare/main...claude/5-x': { total_commits: 300, commits: [{ sha: SHA, commit: { message: 'm' } }], files: [listPatch('b')] },
  }));
  assert.equal(tooManyCommits.code, 3, tooManyCommits.stderr + tooManyCommits.stdout);
  assert.match(JSON.parse(tooManyCommits.stderr).error, /^cannot scan all of branch claude\/5-x: /);

  const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.txt`, status: 'added', sha: `s${i}`, patch: '@@ +1 @@\n+x' }));
  const tooManyFiles = runLeak(cleanRoutes({
    'api repos/o/r/compare/main...claude/5-x': { total_commits: 1, commits: [{ sha: SHA, commit: { message: 'm' } }], files },
  }));
  assert.equal(tooManyFiles.code, 3, tooManyFiles.stderr + tooManyFiles.stdout);
  assert.match(JSON.parse(tooManyFiles.stderr).error, /^cannot scan all of branch claude\/5-x: /);

  const tooManyFilesInCommit = runLeak(cleanRoutes({ [`api repos/o/r/commits/${SHA}`]: { files } }));
  assert.equal(tooManyFilesInCommit.code, 3, tooManyFilesInCommit.stderr + tooManyFilesInCommit.stdout);
  assert.match(JSON.parse(tooManyFilesInCommit.stderr).error, /^cannot scan all of branch claude\/5-x: /);
});

test('a leak in an issue title, PR body, review comment, review body or commit comment fails and names where', () => {
  const issues = (over) => [[{ number: 5, title: 'Reject very long titles', body: 'Note.' }], [{ number: 9, title: 'PR', body: 'Fixes #5', pull_request: { url: 'u' }, ...over }]];
  const cases = [
    [{ 'api --paginate --slurp repos/o/r/issues?state=all&per_page=100': issues({ title: `t ${FORBIDDEN}` }) }, 'issue #9 title'],
    [{ 'api --paginate --slurp repos/o/r/issues?state=all&per_page=100': issues({ body: `b ${FORBIDDEN}` }) }, 'issue #9 body'],
    [{ 'api --paginate --slurp repos/o/r/pulls/comments?per_page=100': [[{ html_url: 'https://github.com/o/r/pull/9#discussion_r2', body: FORBIDDEN }]] }, 'review comment https://github.com/o/r/pull/9#discussion_r2'],    [{ 'api --paginate --slurp repos/o/r/pulls/9/reviews': [[{ html_url: 'https://github.com/o/r/pull/9#pullrequestreview-2', body: FORBIDDEN }]] }, 'review https://github.com/o/r/pull/9#pullrequestreview-2'],
    [{ 'api --paginate --slurp repos/o/r/comments?per_page=100': [[{ html_url: 'https://github.com/o/r/commit/abcdef1#commitcomment-2', body: FORBIDDEN }]] }, 'commit comment https://github.com/o/r/commit/abcdef1#commitcomment-2'],
  ];
  for (const [extra, where] of cases) {
    const r = runLeak(cleanRoutes(extra));
    assert.equal(r.code, 1, `${where}: ${r.stderr}${r.stdout}`);
    assert.deepEqual(JSON.parse(r.stdout).observed.leaks, [where]);
  }
});

test('every non-default branch is compared, not only the issue\'s own (F3)', () => {
  // "claude/50-y" belongs to another run, but it is public too.
  const r = runLeak(cleanRoutes({
    'api repos/o/r/compare/main...claude/50-y': {
      total_commits: 1,
      commits: [{ sha: '9999999abcdef00', commit: { message: 'other run' } }],
      files: [],
    },
    'api repos/o/r/commits/9999999abcdef00': { files: [{ filename: 'notes.md', status: 'added', sha: 'f500', patch: `@@ -0,0 +1 @@\n+${FORBIDDEN}` }] },
  }));
  assert.equal(r.code, 1, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).observed.leaks, ['branch claude/50-y commit 9999999 file notes.md']);
});

test('the default branch (read from gh api repos/<repo>) is the base and is never compared with itself', () => {
  // main is an ordinary branch here; trunk is the default, so only trunk...<branch> routes exist.
  const r = runLeak(cleanRoutes({
    'api repos/o/r': { default_branch: 'trunk' },
    'api --paginate --slurp repos/o/r/branches': [[{ name: 'trunk' }, { name: 'claude/5-x' }]],
    'api repos/o/r/compare/trunk...claude/5-x': { total_commits: 0, commits: [], files: [] },
  }));
  assert.equal(r.code, 0, r.stderr + r.stdout);
});

test('reviews are fetched only for pull requests, not for plain issues', () => {
  // cleanRoutes has no pulls/5/reviews route (#5 is an issue); fetching it would exit 3.
  const r = runLeak(cleanRoutes());
  assert.equal(r.code, 0, r.stderr + r.stdout);
});

test('a gh failure while scanning for leaks exits 3', () => {
  const r = runLeak(cleanRoutes({ 'api --paginate --slurp repos/o/r/pulls/comments?per_page=100': { __ghError: 'gh: HTTP 500: Internal Server Error' } }));
  assert.equal(r.code, 3, r.stderr);
  assert.match(JSON.parse(r.stderr).error, /500/);
});

test('a fixture without noLeak makes no leak-scan calls and ignores --forbidden-file', () => {
  const sandbox = makeSandbox({ '01-wrong-month.md': 5 });
  const dir = fakeGh(baseRoutes({
    'api repos/o/r/contents/docs/pipeline/5?ref=claude%2F5-x': [],
    'api repos/o/r/contents/docs/pipeline/5/screenshots?ref=claude%2F5-x': [],
  }));
  const r = runVerify(['--sandbox', sandbox, '--fixture', '01-wrong-month.md', '--forbidden-file', path.join(tempDir('vf-'), 'unused.txt')], { PATH: `${dir}:${process.env.PATH}` });
  assert.notEqual(r.code, 2, r.stderr);
  assert.notEqual(r.code, 3, r.stderr);
  assert.equal('leaks' in JSON.parse(r.stdout).observed, false);
});
