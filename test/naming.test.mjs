import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, branchName, keyFromBranch, worktreePath } from '../skills/ship/scripts/lib/naming.mjs';
import { runCli } from './helpers/cli.mjs';

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
