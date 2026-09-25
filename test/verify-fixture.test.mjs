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
