import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeIssue, countOpenClaudePrs } from '../skills/ship/scripts/lib/github.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { runCli } from './helpers/cli.mjs';

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

test('countOpenClaudePrs counts only claude/* heads', () => {
  assert.equal(countOpenClaudePrs([{ headRefName: 'claude/1-a' }, { headRefName: 'feature/x' }, { headRefName: 'claude/2' }]), 2);
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

test('CLI pr-count counts open claude PRs', () => {
  const dir = fakeGh({
    'pr list --repo o/r --state open --limit 500 --json headRefName': [{ headRefName: 'claude/1-a' }, { headRefName: 'main-fix' }],
  });
  const r = runCli(['pr-count', '--repo', 'o/r'], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.deepEqual(r.json(), { count: 1 });
});
