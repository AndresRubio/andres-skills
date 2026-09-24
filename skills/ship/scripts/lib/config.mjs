import { git } from './git.mjs';

export class ConfigError extends Error {}

export const ALWAYS_PROTECTED = Object.freeze(['.github/**', '.claude/**']);

export const DEFAULTS = Object.freeze({
  enabled: true,
  ciChecks: [],
  mergeDeploys: true,
  protectedPaths: [],
  localOnlyPaths: [],
  maxParallel: 2,
  maxPrSize: { files: 25, lines: 800 },
  lockTtlHours: 3,
  preview: null,
});

const KNOWN = new Set(['tracker', ...Object.keys(DEFAULTS)]);
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
const isPosInt = (v) => Number.isInteger(v) && v >= 1;

export function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('pipeline.json must be a JSON object');
  }
  const problems = [];
  for (const key of Object.keys(raw)) if (!KNOWN.has(key)) problems.push(`unknown field "${key}"`);
  const t = raw.tracker;
  if (!t || typeof t !== 'object') problems.push('"tracker" is required');
  else if (t.type === 'linear') {
    if (typeof t.team !== 'string' || t.team === '') problems.push('"tracker.team" is required for linear');
  } else if (t.type !== 'github') problems.push('"tracker.type" must be "github" or "linear"');
  if ('enabled' in raw && typeof raw.enabled !== 'boolean') problems.push('"enabled" must be a boolean');
  if ('mergeDeploys' in raw && typeof raw.mergeDeploys !== 'boolean') problems.push('"mergeDeploys" must be a boolean');
  for (const k of ['ciChecks', 'protectedPaths', 'localOnlyPaths']) {
    if (k in raw && !isStringArray(raw[k])) problems.push(`"${k}" must be an array of non-empty strings`);
  }
  if ('maxParallel' in raw && !isPosInt(raw.maxParallel)) problems.push('"maxParallel" must be an integer >= 1');
  if ('maxPrSize' in raw && !(raw.maxPrSize && isPosInt(raw.maxPrSize.files) && isPosInt(raw.maxPrSize.lines))) {
    problems.push('"maxPrSize" must be { "files": integer >= 1, "lines": integer >= 1 }');
  }
  if ('lockTtlHours' in raw && !(typeof raw.lockTtlHours === 'number' && raw.lockTtlHours > 0)) {
    problems.push('"lockTtlHours" must be a number > 0');
  }
  if ('preview' in raw && raw.preview !== null
    && !(raw.preview && typeof raw.preview.command === 'string' && raw.preview.command.includes('{port}'))) {
    problems.push('"preview.command" must be a string containing {port}');
  }
  if (problems.length) throw new ConfigError(`invalid pipeline.json: ${problems.join('; ')}`);
  const config = { ...DEFAULTS, ...raw };
  return { ...config, protectedPathsEffective: [...ALWAYS_PROTECTED, ...config.protectedPaths] };
}

function gitErrorText(err) {
  return (err.stderr ?? err.message ?? '').trim();
}

export function defaultBranchRef(repoRoot) {
  try {
    return git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
  } catch (err) {
    const stderr = gitErrorText(err);
    if (stderr.includes('not a symbolic ref') || stderr.includes('No such ref')) {
      throw new ConfigError('cannot resolve origin/HEAD (run: git remote set-head origin --auto)');
    }
    throw new ConfigError(`cannot resolve origin/HEAD: ${stderr}`);
  }
}

export function loadConfig(repoRoot, { ref } = {}) {
  const resolvedRef = ref ?? defaultBranchRef(repoRoot);
  let text;
  try {
    text = git(repoRoot, ['show', `${resolvedRef}:.claude/pipeline.json`]);
  } catch (err) {
    const stderr = gitErrorText(err);
    if (stderr.includes('does not exist in')) {
      throw new ConfigError(`no .claude/pipeline.json on ${resolvedRef}`);
    }
    throw new ConfigError(`cannot read .claude/pipeline.json on ${resolvedRef}: ${stderr}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`.claude/pipeline.json on ${resolvedRef} is not valid JSON: ${err.message}`);
  }
  return { ref: resolvedRef, ...validateConfig(raw) };
}
