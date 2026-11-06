import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, loadConfig, ConfigError } from '../skills/ship/scripts/lib/config.mjs';
import { git, makeRepoWithOrigin, writeFiles, tempDir } from './helpers/git.mjs';
import { runCli } from './helpers/cli.mjs';

test('a minimal GitHub config gets every default', () => {
  const c = validateConfig({ tracker: { type: 'github' } });
  assert.equal(c.enabled, true);
  assert.equal(c.mergeDeploys, true);
  assert.deepEqual(c.ciChecks, []);
  assert.equal(c.maxParallel, 2);
  assert.deepEqual(c.maxPrSize, { files: 25, lines: 800 });
  assert.equal(c.lockTtlHours, 3);
  assert.equal(c.preview, null);
  assert.deepEqual(c.protectedPathsEffective, ['.github/**', '.claude/**']);
});

test('configured protected paths are added to the always-protected ones', () => {
  const c = validateConfig({ tracker: { type: 'github' }, protectedPaths: ['src/auth/**'] });
  assert.deepEqual(c.protectedPathsEffective, ['.github/**', '.claude/**', 'src/auth/**']);
});

test('invalid configs are rejected with every problem listed', () => {
  assert.throws(() => validateConfig({ tracker: { type: 'linear' } }), /tracker.team/);
  assert.throws(() => validateConfig({ tracker: { type: 'jira' } }), /tracker.type/);
  assert.throws(() => validateConfig({ tracker: { type: 'github' }, maxparallel: 3 }), /unknown field "maxparallel"/);
  assert.throws(() => validateConfig({ tracker: { type: 'github' }, preview: { command: 'npm run dev' } }), /\{port\}/);
  assert.throws(() => validateConfig({ tracker: { type: 'github' }, maxPrSize: { files: 6 } }), /maxPrSize/);
  assert.throws(() => validateConfig({ tracker: { type: 'github' }, maxParallel: 0 }), /maxParallel/);
  assert.throws(() => validateConfig([]), ConfigError);
});

test('loadConfig reads the default branch, not the working tree', () => {
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, maxParallel: 3 }) });
  git(root, ['checkout', '-b', 'feature']);
  writeFiles(root, { '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, maxParallel: 9 }) });
  git(root, ['commit', '-am', 'change config on a branch']);
  const c = loadConfig(root);
  assert.equal(c.ref, 'origin/main');
  assert.equal(c.maxParallel, 3);
});

test('loadConfig says clearly when the file is missing', () => {
  const { root } = makeRepoWithOrigin();
  assert.throws(() => loadConfig(root), /no \.claude\/pipeline\.json on origin\/main/);
});

test('loadConfig surfaces git\'s real error for a bad explicit ref, not the missing-file message', () => {
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' } }) });
  assert.throws(() => loadConfig(root, { ref: 'origin/nope' }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /cannot read/);
    assert.match(err.message, /origin\/nope/);
    assert.doesNotMatch(err.message, /no \.claude\/pipeline\.json/);
    return true;
  });
});

test('loadConfig says clearly when run outside a git repository', () => {
  assert.throws(() => loadConfig(tempDir()), /not a git repository/);
});

test('CLI config prints the loaded config', () => {
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, ciChecks: ['test'] }) });
  const r = runCli(['config', '--repo-root', root]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().ref, 'origin/main');
  assert.deepEqual(r.json().ciChecks, ['test']);
  const missing = runCli(['config', '--repo-root', makeRepoWithOrigin().root]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no \.claude\/pipeline\.json/);
});

test('hydrateHosts and autoMerge have defaults and are validated', () => {
  const c = validateConfig({ tracker: { type: 'github' } });
  assert.deepEqual(c.hydrateHosts, ['github.com']);
  assert.equal(c.autoMerge, false);
  const custom = validateConfig({ tracker: { type: 'github' }, hydrateHosts: ['github.com', 'docs.example.com'], autoMerge: true });
  assert.deepEqual(custom.hydrateHosts, ['github.com', 'docs.example.com']);
  assert.equal(custom.autoMerge, true);
  assert.throws(() => validateConfig({ tracker: { type: 'github' }, hydrateHosts: 'github.com' }), /hydrateHosts/);
  assert.throws(() => validateConfig({ tracker: { type: 'github' }, autoMerge: 'yes' }), /autoMerge/);
});
