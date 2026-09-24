import os from 'node:os';
import path from 'node:path';

export function slugify(title, max = 40) {
  const ascii = String(title).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

export function branchName(key, title) {
  const slug = slugify(title);
  return slug ? `claude/${key}-${slug}` : `claude/${key}`;
}

export function keyFromBranch(branch) {
  const m = String(branch).match(/^claude\/(\d+|[a-z][a-z0-9]*-\d+)(?:-|$)/);
  if (!m) throw new Error(`not a pipeline branch: ${branch}`);
  return m[1];
}

export function pipelineHome(env = process.env) {
  return env.CLAUDE_PIPELINE_HOME || path.join(os.homedir(), '.claude-pipeline');
}

export function worktreePath(repoRoot, key, env = process.env) {
  return path.join(pipelineHome(env), 'worktrees', path.basename(path.resolve(repoRoot)), key);
}
