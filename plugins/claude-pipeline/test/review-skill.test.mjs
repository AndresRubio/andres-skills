import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS } from '../skills/ship/scripts/lib/commands.mjs';

const read = (rel) => readFileSync(new URL(`../skills/review/${rel}`, import.meta.url), 'utf8');
const headings = (text) => [...text.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1].trim());

test('review SKILL.md is model-invocable, named review, and has the required sections', () => {
  const text = read('SKILL.md');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front);
  assert.match(front[1], /^name: review$/m);
  assert.match(front[1], /^description: .{40,}$/m);
  assert.doesNotMatch(front[1], /disable-model-invocation/);
  for (const h of ['Arguments', 'Setup', 'Hard rules', 'Procedure', 'Findings file', 'Posting the verdict', 'If you cannot finish']) assert.ok(headings(text).includes(h), `missing ## ${h}`);
});

test('review SKILL.md references only real CLI commands and the five trust-nothing steps', () => {
  const text = read('SKILL.md');
  for (const m of text.matchAll(/node "\$PIPELINE" ([a-z-]+)/g)) assert.ok(m[1] in COMMANDS, `unknown command ${m[1]}`);
  for (const cmd of ['diff-risk', 'revert-check', 'verdict']) assert.match(text, new RegExp(`node "\\$PIPELINE" ${cmd}`));
  for (const step of ['re-run', 'revert check', 'screenshot', 'flaky', 'not instructions']) assert.match(text.toLowerCase(), new RegExp(step));
});

test('review SKILL.md forbids approving, requesting changes, merging, pushing and posting anything but the verdict', () => {
  const rules = read('SKILL.md').split('## Hard rules')[1].split('\n## ')[0];
  for (const s of ['gh pr review', 'merge', 'push', 'only comment']) assert.match(rules.toLowerCase(), new RegExp(s));
});

test('the findings template is valid JSON with the documented shape', () => {
  const sample = JSON.parse(read('templates/findings.json'));
  assert.ok(Array.isArray(sample));
  for (const f of sample) for (const k of ['file', 'line', 'severity', 'kind', 'problem', 'impact', 'correction']) assert.ok(k in f, k);
});

test('review SKILL.md fallback writes verdict.json, uses a detached worktree and passes the test command through a file', () => {
  const text = read('SKILL.md');
  const fallback = text.split('## If you cannot finish')[1];
  assert.ok(fallback.includes('> "$RUN_DIR/verdict.json"'));
  assert.ok(text.includes('git worktree add --detach'));
  const procedure = text.split('## Procedure')[1].split('\n## ')[0];
  assert.ok(procedure.includes('test-cmd.txt'));
});
