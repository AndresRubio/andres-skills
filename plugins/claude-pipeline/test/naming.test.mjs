import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { slugify, branchName, keyFromBranch, worktreePath } from '../skills/ship/scripts/lib/naming.mjs';
import { runCli } from './helpers/cli.mjs';
import { tempDir } from './helpers/git.mjs';

test('slugify strips accents and punctuation', () => {
  assert.equal(slugify('Ataques del Goblin Fanático: 1D6!'), 'ataques-del-goblin-fanatico-1d6');
});

test('slugify cuts long titles at a word boundary', () => {
  const slug = slugify('Make the whole app bilingual in English and Spanish with a switcher');
  assert.ok(slug.length <= 40, slug);
  assert.equal(slug, 'make-the-whole-app-bilingual-in-english');
});

test('branchName uses claude/<key>-<slug>, or claude/<key> for an empty slug', () => {
  assert.equal(branchName('12', 'Added dates show the wrong month'), 'claude/12-added-dates-show-the-wrong-month');
  assert.equal(branchName('12', '!!!'), 'claude/12');
});

test('keyFromBranch reads GitHub and Linear keys', () => {
  assert.equal(keyFromBranch('claude/12-added-dates'), '12');
  assert.equal(keyFromBranch('claude/12'), '12');
  assert.equal(keyFromBranch('claude/old-43-ataques'), 'old-43');
  assert.throws(() => keyFromBranch('feature/old-43-x'), /not a pipeline branch/);
});

test('worktreePath lives under the pipeline home, outside the repo', () => {
  const p = worktreePath('/Users/me/projects/sandbox', '12', { CLAUDE_PIPELINE_HOME: '/tmp/cph' });
  assert.equal(p, '/tmp/cph/worktrees/sandbox/12');
});

test('CLI branch-name, key-from-branch and worktree-path', () => {
  assert.deepEqual(runCli(['branch-name', '--key', '5', '--title', 'Friendlier empty state']).json(), { branch: 'claude/5-friendlier-empty-state' });
  assert.deepEqual(runCli(['key-from-branch', 'claude/5-friendlier-empty-state']).json(), { key: '5' });
  const r = runCli(['worktree-path', '--repo-root', '/x/sandbox', '--key', '5'], { env: { CLAUDE_PIPELINE_HOME: '/tmp/cph' } });
  assert.deepEqual(r.json(), { path: '/tmp/cph/worktrees/sandbox/5' });
  assert.equal(runCli(['branch-name', '--key', '5']).code, 2);
});

test('CLI branch-name --issue-file reads the title from JSON, keeping untrusted text out of the shell', () => {
  const dir = tempDir();
  const issueFile = path.join(dir, 'issue.json');
  const title = 'Fix `npm test` flake and $(rm -rf /)';
  writeFileSync(issueFile, JSON.stringify({ title }));
  const r = runCli(['branch-name', '--key', '5', '--issue-file', issueFile]);
  assert.deepEqual(r.json(), { branch: branchName('5', title) });
});

test('CLI branch-name requires exactly one of --title / --issue-file', () => {
  const dir = tempDir();
  const issueFile = path.join(dir, 'issue.json');
  writeFileSync(issueFile, JSON.stringify({ title: 'x' }));
  assert.equal(runCli(['branch-name', '--key', '5']).code, 2, 'neither');
  assert.equal(runCli(['branch-name', '--key', '5', '--title', 'x', '--issue-file', issueFile]).code, 2, 'both');
});

test('CLI branch-name --issue-file is a domain error when the file is missing, unparsable, or has no string title', () => {
  const dir = tempDir();
  assert.equal(runCli(['branch-name', '--key', '5', '--issue-file', path.join(dir, 'missing.json')]).code, 1, 'missing file');
  const badJson = path.join(dir, 'bad.json');
  writeFileSync(badJson, 'not json');
  assert.equal(runCli(['branch-name', '--key', '5', '--issue-file', badJson]).code, 1, 'unparsable');
  const noTitle = path.join(dir, 'no-title.json');
  writeFileSync(noTitle, JSON.stringify({ notTitle: 'x' }));
  assert.equal(runCli(['branch-name', '--key', '5', '--issue-file', noTitle]).code, 1, 'no string title');
});
