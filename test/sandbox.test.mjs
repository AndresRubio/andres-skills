import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';

const dir = (rel) => new URL(`../sandbox/${rel}`, import.meta.url);

test('the sandbox pipeline config is valid and uses small PR limits', () => {
  const c = validateConfig(JSON.parse(readFileSync(dir('app/.claude/pipeline.json'), 'utf8')));
  assert.equal(c.mergeDeploys, false);
  assert.deepEqual(c.maxPrSize, { files: 6, lines: 250 });
  assert.deepEqual(c.ciChecks, ['test']);
});

test('every seeded issue has a title, labels and a body', () => {
  const files = readdirSync(dir('issues')).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files.sort(), ['01-wrong-month.md', '02-sort.md', '03-login.md', '04-bilingual.md', '05-empty-state.md', '06-protected-rename.md', '06b-ci-node.md', '07-title-typo.md', '09a-count.md', '09b-clear.md']);
  for (const f of files) {
    const [title, labels, sep, ...body] = readFileSync(dir(`issues/${f}`), 'utf8').split('\n');
    assert.match(title, /^title: \S/, f);
    assert.match(labels, /^labels: [a-z,-]+$/, f);
    assert.equal(sep, '---', f);
    assert.ok(body.join('\n').trim().length > 10, f);
  }
});

test('the planted defects are present', () => {
  assert.match(readFileSync(dir('app/src/list.ts'), 'utf8'), /getUTCMonth\(\) \+ 1/);
  assert.match(readFileSync(dir('app/index.html'), 'utf8'), /<title>Readng List<\/title>/);
});

test('fixtures 01-07 (including 06b) carry the claude label; 09a and 09b do not', () => {
  const withClaude = ['01-wrong-month.md', '02-sort.md', '03-login.md', '04-bilingual.md', '05-empty-state.md', '06-protected-rename.md', '06b-ci-node.md', '07-title-typo.md'];
  const withoutClaude = ['09a-count.md', '09b-clear.md'];
  const labelsOf = (f) => readFileSync(dir(`issues/${f}`), 'utf8').split('\n')[1].replace(/^labels: /, '').split(',');
  for (const f of withClaude) assert.ok(labelsOf(f).includes('claude'), f);
  for (const f of withoutClaude) assert.ok(!labelsOf(f).includes('claude'), f);
});

test('every label used on a seeded issue is a known sandbox label', () => {
  const known = new Set(['claude', 'claude-go', 'needs-local', 'needs-decision', 'claude-working', 'ship-it', 'claude-fix', 'bug', 'enhancement']);
  const files = readdirSync(dir('issues')).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const labelsLine = readFileSync(dir(`issues/${f}`), 'utf8').split('\n')[1];
    const labels = labelsLine.replace(/^labels: /, '').split(',');
    for (const label of labels) assert.ok(known.has(label), `${f}: unknown label "${label}"`);
  }
});

test('both sandbox scripts are syntactically valid bash', () => {
  for (const script of ['setup-sandbox.sh', 'recreate-issue.sh']) {
    assert.doesNotThrow(() => execFileSync('bash', ['-n', fileURLToPath(dir(script))]), script);
  }
});
