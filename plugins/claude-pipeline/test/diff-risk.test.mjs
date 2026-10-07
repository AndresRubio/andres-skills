import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestFile, analyzeDiff, diffRisk } from '../skills/ship/scripts/lib/diff-risk.mjs';
import { git, makeRepoWithOrigin, writeFiles } from './helpers/git.mjs';
import { runCli } from './helpers/cli.mjs';

test('isTestFile recognises common test layouts and nothing else', () => {
  for (const f of ['src/list.test.ts', 'src/render.spec.js', 'test/cli.test.mjs', 'tests/test_api.py', 'pkg/__tests__/x.tsx', 'spec/models/user_spec.rb', 'internal/x_test.go', 'test/t.sh']) {
    assert.equal(isTestFile(f), true, f);
  }
  for (const f of ['src/list.ts', 'README.md', 'testing-guide.md', 'contest/winner.ts', 'docs/pipeline/12/spec.md']) {
    assert.equal(isTestFile(f), false, f);
  }
});

const patchFor = (file, removed, added) => [
  `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,${removed.length} +1,${added.length} @@`,
  ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`),
].join('\n');

test('analyzeDiff flags deleted and renamed test files', () => {
  const r = analyzeDiff({ nameStatus: 'D\tsrc/list.test.ts\nR100\tsrc/a.test.ts\tsrc/b.test.ts\nM\tsrc/list.ts', patch: '' });
  assert.deepEqual(r.hits.map((h) => [h.rule, h.file]), [['test-file-removed', 'src/list.test.ts'], ['test-file-removed', 'src/a.test.ts']]);
  assert.match(r.hits[1].detail, /renamed to src\/b\.test\.ts/);
});

test('analyzeDiff flags test files that lose more assertions than they gain', () => {
  const patch = patchFor('src/list.test.ts', ['expect(a).toBe(1);', 'expect(b).toBe(2);', 'assert.equal(c, 3);'], ['expect(a).toBe(1);']);
  const r = analyzeDiff({ nameStatus: 'M\tsrc/list.test.ts', patch });
  assert.deepEqual(r.hits.map((h) => h.rule), ['assertions-lost']);
  assert.match(r.hits[0].detail, /3 removed, 1 added/);
  const gain = analyzeDiff({ nameStatus: 'M\tsrc/list.test.ts', patch: patchFor('src/list.test.ts', ['expect(a).toBe(1);'], ['expect(a).toBe(1);', 'expect(b).toBe(2);']) });
  assert.deepEqual(gain.hits, []);
});

test('analyzeDiff flags new skip markers and suppressions in any file, added lines only', () => {
  const patch = [
    patchFor('src/list.test.ts', ['it("x", () => {});'], ['it.only("x", () => {});', 'describe.skip("y", () => {});']),
    patchFor('src/list.ts', ['const a = 1;'], ['// @ts-ignore', 'const a: number = "1"; // eslint-disable-line']),
    patchFor('api/test_x.py', [], ['@pytest.mark.skip', 'x = 1  # noqa', 'y = 2  # type: ignore']),
    patchFor('src/old.ts', ['// @ts-ignore'], []),
  ].join('\n');
  const r = analyzeDiff({ nameStatus: 'M\tsrc/list.test.ts\nM\tsrc/list.ts\nM\tapi/test_x.py\nM\tsrc/old.ts', patch });
  const skip = r.hits.filter((h) => h.rule === 'skip-marker');
  assert.equal(skip.length, 7);
  assert.ok(skip.every((h) => h.file !== 'src/old.ts'), 'a removed suppression is not a hit');
  assert.ok(skip.some((h) => h.file === 'src/list.test.ts' && h.detail.includes('.only(')));
  assert.ok(skip.some((h) => h.file === 'api/test_x.py' && h.detail.includes('# noqa')));
});

test('analyzeDiff flags test, lint, typecheck and coverage config, and dependency manifests', () => {
  const ns = ['M\tvitest.config.ts', 'M\teslint.config.js', 'M\ttsconfig.json', 'M\tpackage.json', 'M\tpackage-lock.json', 'A\tuv.lock', 'M\tpyproject.toml', 'M\tsrc/index.ts'].join('\n');
  const r = analyzeDiff({ nameStatus: ns, patch: patchFor('vitest.config.ts', ['thresholds: { lines: 90 }'], ['thresholds: { lines: 40 }']) });
  const byRule = (rule) => r.hits.filter((h) => h.rule === rule).map((h) => h.file).sort();
  assert.deepEqual(byRule('test-config-changed'), ['eslint.config.js', 'pyproject.toml', 'tsconfig.json', 'vitest.config.ts']);
  assert.deepEqual(byRule('dependency-changed'), ['package-lock.json', 'package.json', 'pyproject.toml', 'uv.lock']);
  assert.ok(r.hits.find((h) => h.file === 'vitest.config.ts').detail.includes('coverage threshold'));
  assert.ok(!r.hits.some((h) => h.file === 'src/index.ts'));
});

test('analyzeDiff on a clean change has no hits', () => {
  const r = analyzeDiff({ nameStatus: 'M\tsrc/list.ts\nM\tsrc/list.test.ts', patch: patchFor('src/list.test.ts', [], ['expect(x).toBe(1);']) });
  assert.deepEqual(r.hits, []);
});

test('parsePatch handles removed lines starting with three dashes correctly', () => {
  // Removed line with content `-- expect(...)` appears in raw diff as `--- expect(...)`,
  // which the old prefix-only parser would mistake for a file header
  const patch = [
    `diff --git a/src/list.test.ts b/src/list.test.ts`,
    `--- a/src/list.test.ts`,
    `+++ b/src/list.test.ts`,
    `@@ -1,3 +1,1 @@`,
    `--- expect(1).toBe(1);`,
    `-expect(2).toBe(2);`,
    `-assert.equal(c, 3);`,
    `+expect(x).toBe(x);`,
  ].join('\n');
  const r = analyzeDiff({ nameStatus: 'M\tsrc/list.test.ts', patch });
  assert.deepEqual(r.hits.map((h) => h.rule), ['assertions-lost']);
  assert.match(r.hits[0].detail, /3 removed, 1 added/);
});

test('parsePatch handles added lines starting with three plusses correctly', () => {
  // Added line with content `++ b/src/x.ts` appears in raw diff as `+++ b/src/x.ts`,
  // which the old prefix-only parser would mistake for a file header and lose context
  const patch = [
    `diff --git a/src/real.test.ts b/src/real.test.ts`,
    `--- a/src/real.test.ts`,
    `+++ b/src/real.test.ts`,
    `@@ -1,2 +1,3 @@`,
    ` it('existing', () => {});`,
    `-old code`,
    `+++ b/src/x.ts`,
    `+it.only(1)`,
  ].join('\n');
  const r = analyzeDiff({ nameStatus: 'M\tsrc/real.test.ts', patch });
  const skip = r.hits.filter((h) => h.rule === 'skip-marker');
  assert.equal(skip.length, 1);
  assert.equal(skip[0].file, 'src/real.test.ts');
  assert.match(skip[0].detail, /\.only\(/);
});

test('diffRisk handles test file with spaces in path', () => {
  const { root } = makeRepoWithOrigin({ 't/a b.test.ts': 'expect(1).toBe(1);\nexpect(2).toBe(2);\n' });
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', '-b', 'fix']);
  writeFiles(root, { 't/a b.test.ts': 'expect(1).toBe(1);\n' });
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'change']);
  const r = diffRisk(root, base);
  assert.deepEqual(r.hits.map((h) => h.rule), ['assertions-lost']);
  assert.equal(r.hits[0].file, 't/a b.test.ts');
});

test('parsePatch handles deleted test file with /dev/null correctly', () => {
  // A deleted file has +++ /dev/null, which should not create assertions-lost hits
  const patch = [
    `diff --git a/src/old.test.ts b/src/old.test.ts`,
    `--- a/src/old.test.ts`,
    `+++ /dev/null`,
    `@@ -1,2 +0,0 @@`,
    `-expect(1).toBe(1);`,
    `-expect(2).toBe(2);`,
  ].join('\n');
  const r = analyzeDiff({ nameStatus: 'D\tsrc/old.test.ts', patch });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].rule, 'test-file-removed');
  assert.equal(r.hits[0].file, 'src/old.test.ts');
});

test('diffRisk reads git and excludes docs/pipeline', () => {
  const { root } = makeRepoWithOrigin({ 'src/a.test.ts': 'expect(1).toBe(1);\nexpect(2).toBe(2);\n', 'package.json': '{"name":"x"}\n' });
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', '-b', 'claude/1-x']);
  writeFiles(root, { 'src/a.test.ts': 'expect(1).toBe(1);\n', 'package.json': '{"name":"x","dependencies":{"left-pad":"1"}}\n', 'docs/pipeline/1/spec.md': 'it.only(\n' });
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'change']);
  const r = diffRisk(root, base);
  assert.deepEqual(r.hits.map((h) => h.rule).sort(), ['assertions-lost', 'dependency-changed']);
  const cli = runCli(['diff-risk', '--base', base, '--cwd', root]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(cli.json().hits.length, 2);
});
