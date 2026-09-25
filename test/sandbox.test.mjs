import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
