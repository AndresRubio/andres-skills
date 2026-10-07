import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TEMPLATES = new URL('../../../../templates/', import.meta.url);
const PLUGIN_JSON = new URL('../../../../.claude-plugin/plugin.json', import.meta.url);
const WORKFLOWS = ['claude-ship.yml', 'claude-review.yml', 'pipeline-ready.yml'];
const PLACEHOLDERS = ['PLUGIN_REPO', 'PLUGIN_REPO_SLUG', 'PLUGIN_REF', 'PLUGIN_SUBDIR', 'MARKETPLACE', 'CI_WORKFLOWS', 'CI_WORKFLOWS_WITH_REVIEW'];

export const LABELS = Object.freeze([
  { name: 'claude', color: '5319e7', description: 'Opt in to the claude-pipeline automatic lanes' },
  { name: 'claude-go', color: '0e8a16', description: "Treat as ready: accept the pipeline's assumptions" },
  { name: 'needs-local', color: 'fbca04', description: "Needs files that exist only on the owner's Mac" },
  { name: 'needs-decision', color: 'd93f0b', description: 'Pipeline stopped, waiting for the owner' },
  { name: 'claude-working', color: '1d76db', description: 'Locked by a pipeline run' },
  { name: 'claude-fix', color: 'b60205', description: 'Pipeline fix run requested' },
  { name: 'ready', color: '0e8a16', description: 'Green CI, accepted review verdict, branch up to date: yours to merge' },
]);

export function slugOf(repoUrl) {
  const m = String(repoUrl).match(/github\.com[/:]([^/]+\/[^/.]+)(\.git)?$/);
  if (!m) throw new Error(`cannot derive owner/name from ${repoUrl}`);
  return m[1];
}

const list = (items) => `[${items.join(', ')}]`;

export function defaultVars({ ciWorkflows = ['CI'], pluginRepo = 'https://github.com/AndresRubio/andres-skills.git', pluginRef, pluginSubdir = 'plugins/claude-pipeline/', marketplace = 'andres-skills' } = {}) {
  const version = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).version;
  return {
    PLUGIN_REPO: pluginRepo,
    PLUGIN_REPO_SLUG: slugOf(pluginRepo),
    PLUGIN_REF: pluginRef ?? `claude-pipeline--v${version}`,
    PLUGIN_SUBDIR: pluginSubdir,
    MARKETPLACE: marketplace,
    CI_WORKFLOWS: list(ciWorkflows),
    CI_WORKFLOWS_WITH_REVIEW: list([...ciWorkflows, 'claude-review']),
  };
}

export function renderWorkflow(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!PLACEHOLDERS.includes(name)) throw new Error(`unknown placeholder ${name}`);
    if (vars[name] === undefined || vars[name] === '') throw new Error(`placeholder ${name} has no value`);
    return vars[name];
  });
}

export function installFiles(repoRoot, vars, { force = false } = {}) {
  const written = [];
  const skipped = [];
  const put = (rel, content, { overwrite = false } = {}) => {
    const full = path.join(repoRoot, rel);
    if (existsSync(full) && !overwrite) { skipped.push(rel); return; }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    written.push(rel);
  };
  for (const name of WORKFLOWS) {
    put(`.github/workflows/${name}`, renderWorkflow(readFileSync(new URL(`github/${name}`, TEMPLATES), 'utf8'), vars), { overwrite: force });
  }
  // The owner's config (ciChecks, protectedPaths, ...) is never overwritten, not even with force.
  put('.claude/pipeline.json', readFileSync(new URL('pipeline.json', TEMPLATES), 'utf8'));
  return { written, skipped };
}
