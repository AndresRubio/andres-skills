import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { renderWorkflow, installFiles, defaultVars, LABELS } from '../skills/ship/scripts/lib/setup.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';
import { tempDir, writeFiles } from './helpers/git.mjs';
import { runCli } from './helpers/cli.mjs';

test('renderWorkflow fills every placeholder and rejects unknown or missing ones', () => {
  const out = renderWorkflow('repo: {{PLUGIN_REPO}} slug: {{PLUGIN_REPO_SLUG}} ref: {{PLUGIN_REF}} sub: {{PLUGIN_SUBDIR}} mk: {{MARKETPLACE}} ci: {{CI_WORKFLOWS}} rv: {{CI_WORKFLOWS_WITH_REVIEW}}', { PLUGIN_REPO: 'https://x/y.git', PLUGIN_REPO_SLUG: 'x/y', PLUGIN_REF: 'v1', PLUGIN_SUBDIR: 'p/', MARKETPLACE: 'm', CI_WORKFLOWS: '[CI, Lint]', CI_WORKFLOWS_WITH_REVIEW: '[CI, Lint, claude-review]' });
  assert.equal(out, 'repo: https://x/y.git slug: x/y ref: v1 sub: p/ mk: m ci: [CI, Lint] rv: [CI, Lint, claude-review]');
  assert.throws(() => renderWorkflow('{{NOPE}}', defaultVars()), /unknown placeholder NOPE/);
  assert.throws(() => renderWorkflow('{{PLUGIN_REF}}', { ...defaultVars(), PLUGIN_REF: undefined }), /PLUGIN_REF/);
});

test('defaultVars pins the plugin ref to the current version and points at andres-skills', () => {
  const v = defaultVars();
  assert.match(v.PLUGIN_REF, /^claude-pipeline--v\d+\.\d+\.\d+$/);
  assert.equal(v.PLUGIN_REPO, 'https://github.com/AndresRubio/andres-skills.git');
  assert.equal(v.PLUGIN_REPO_SLUG, 'AndresRubio/andres-skills');
  assert.equal(v.PLUGIN_SUBDIR, 'plugins/claude-pipeline/');
  assert.equal(v.MARKETPLACE, 'andres-skills');
  assert.equal(v.CI_WORKFLOWS, '[CI]');
  assert.equal(v.CI_WORKFLOWS_WITH_REVIEW, '[CI, claude-review]');
});

test('installFiles writes three workflows and a config, never overwriting without --force', () => {
  const root = tempDir();
  const r = installFiles(root, defaultVars(), {});
  assert.deepEqual(r.written.sort(), ['.claude/pipeline.json', '.github/workflows/claude-review.yml', '.github/workflows/claude-ship.yml', '.github/workflows/pipeline-ready.yml']);
  assert.ok(validateConfig(JSON.parse(readFileSync(path.join(root, '.claude/pipeline.json'), 'utf8'))));
  for (const f of r.written) assert.doesNotMatch(readFileSync(path.join(root, f), 'utf8'), /\{\{[A-Z_]+\}\}/, `${f} still has a placeholder`);
  writeFiles(root, { '.github/workflows/claude-ship.yml': 'custom\n' });
  const again = installFiles(root, defaultVars(), {});
  assert.deepEqual(again.written, []);
  assert.equal(again.skipped.length, 4);
  assert.equal(readFileSync(path.join(root, '.github/workflows/claude-ship.yml'), 'utf8'), 'custom\n');
  const forced = installFiles(root, defaultVars(), { force: true });
  assert.deepEqual(forced.written.sort(), ['.github/workflows/claude-review.yml', '.github/workflows/claude-ship.yml', '.github/workflows/pipeline-ready.yml']);
  assert.deepEqual(forced.skipped, ['.claude/pipeline.json']);
  assert.notEqual(readFileSync(path.join(root, '.github/workflows/claude-ship.yml'), 'utf8'), 'custom\n');
  writeFiles(root, { '.claude/pipeline.json': '{"mine":true}\n' });
  installFiles(root, defaultVars(), { force: true });
  assert.equal(readFileSync(path.join(root, '.claude/pipeline.json'), 'utf8'), '{"mine":true}\n');
});

test('LABELS are the seven Phase 2a labels', () => {
  assert.deepEqual(LABELS.map((l) => l.name).sort(), ['claude', 'claude-fix', 'claude-go', 'claude-working', 'needs-decision', 'needs-local', 'ready']);
  for (const l of LABELS) { assert.match(l.color, /^[0-9a-f]{6}$/); assert.ok(l.description.length > 10); }
});

test('CLI setup renders with overrides', () => {
  const root = tempDir();
  const r = runCli(['setup', '--repo-root', root, '--plugin-ref', 'claude-pipeline--v9.9.9', '--ci-workflows', 'CI,Lint']);
  assert.equal(r.code, 0, r.stderr);
  const ready = readFileSync(path.join(root, '.github/workflows/pipeline-ready.yml'), 'utf8');
  assert.match(ready, /ref: claude-pipeline--v9\.9\.9/);
  assert.match(ready, /workflows: \[CI, Lint, claude-review\]/);
  assert.equal(existsSync(path.join(root, '.claude/pipeline.json')), true);
});

const doc = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('setup skill: installs the Claude GitHub App before the secrets, and PIPELINE_TOKEN is required, not an App token', () => {
  const text = doc('skills/setup/SKILL.md');
  const steps = text.split('## Steps')[1].split('\n## ')[0];
  const app = steps.indexOf('/install-github-app');
  const secrets = steps.indexOf('CLAUDE_CODE_OAUTH_TOKEN');
  assert.ok(app > 0 && app < secrets, 'the Claude GitHub App step must come before the secrets step');
  assert.match(steps, /https:\/\/github\.com\/apps\/claude/);
  assert.match(steps, /claude\[bot\]/);
  assert.match(steps, /`PIPELINE_TOKEN`[^\n]*required/i);
  assert.match(steps, /contents: write[^\n]*issues: write[^\n]*pull-requests: write/);
  assert.match(steps, /start no workflows/);
  assert.doesNotMatch(text, /GitHub App token/);
  assert.doesNotMatch(text, /`PIPELINE_TOKEN` is optional|Optional second secret/);
});

test('README: names both secrets and the Claude GitHub App', () => {
  const text = doc('README.md');
  const wf = text.split('## Workflows')[1].split('\n## ')[0];
  assert.match(wf, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(wf, /PIPELINE_TOKEN/);
  assert.match(wf, /\/install-github-app/);
  assert.doesNotMatch(wf, /The one secret/);
  assert.doesNotMatch(text, /GitHub App token/);
});
