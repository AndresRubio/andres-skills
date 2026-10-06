import { KEY_RE } from './runs.mjs';

export const CHECKLIST_FIELDS = Object.freeze({
  estimatedFiles: 'integer',
  estimatedLines: 'integer',
  estimatedTasks: 'integer',
  independentSubsystems: 'boolean',
  assumptions: 'string[]',
  missingValues: 'string[]',
  changesUserVisibleBehaviourNotInIssue: 'boolean',
  changesDataModelApiAuthOrDeps: 'boolean',
  acceptanceCriteriaDerivable: 'boolean',
  needsWorkflowChanges: 'boolean',
  waitFor: 'string[]',
  waitOverride: 'boolean',
  claudeGo: 'boolean',
});

export const MAX_PLAN_TASKS = 8;
export const MAX_ASSUMPTIONS = 3;

function hasType(value, type) {
  if (type === 'integer') return Number.isInteger(value) && value >= 0;
  if (type === 'boolean') return typeof value === 'boolean';
  return Array.isArray(value) && value.every((s) => typeof s === 'string');
}

export function validateChecklist(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new Error('checklist must be a JSON object');
  const problems = [];
  for (const [name, type] of Object.entries(CHECKLIST_FIELDS)) {
    if (!hasType(c[name], type)) problems.push(`"${name}" must be ${type === 'integer' ? 'an integer >= 0' : type}`);
  }
  for (const name of Object.keys(c)) if (!Object.hasOwn(CHECKLIST_FIELDS, name)) problems.push(`unknown field "${name}"`);
  if (problems.length) throw new Error(`invalid checklist: ${problems.join('; ')}`);
  return c;
}

// How a run key reads in a reason or note: #12, PR #41, or the key itself.
function runLabel(key) {
  if (/^\d+$/.test(key)) return `#${key}`;
  if (/^pr-\d+$/.test(key)) return `PR #${key.slice(3)}`;
  return key;
}

// The waitFor keys that still name a run ahead of this one that it can wait for.
// The others are dropped, each with a note.
function keptWaits(waitFor, activeRuns, notes) {
  if (!waitFor.length) return [];
  if (!activeRuns) throw new Error('--active-runs-file is required when waitFor is not empty');
  if (activeRuns.self?.lockedAt == null) throw new Error('waitFor needs a count taken after the lock');
  for (const key of waitFor) if (!KEY_RE.test(key)) throw new Error(`waitFor "${key}" is not a run key`);
  const kept = [];
  for (const key of new Set(waitFor)) {
    const run = activeRuns.runs.find((r) => r.key === key);
    if (!run || !activeRuns.ahead.includes(key)) notes.push(`${runLabel(key)} is no longer a run ahead of this one`);
    else if (run.related) notes.push(`${runLabel(key)} is this issue's parent or sub-issue`);
    else if (run.issue === null) notes.push(`${runLabel(key)} isn't a pipeline issue run; it counts for room only`);
    else kept.push(key);
  }
  return kept;
}

export function gradeVerdict(checklist, { maxPrSize, mode, activeRuns }) {
  const c = validateChecklist(checklist);
  const notes = [];
  const kept = keptWaits(c.waitFor, activeRuns, notes);
  const result = (verdict, reasons, extra = {}) => ({ verdict, reasons, ...extra, ...(notes.length ? { notes } : {}) });

  if (mode === 'auto' && c.needsWorkflowChanges) {
    return result('fork', ['needs .github/workflows changes, which automatic lanes may not make']);
  }
  if (c.missingValues.length) return result('fork', c.missingValues.map((v) => `missing value: ${v}`));
  const big = [];
  if (c.estimatedFiles > maxPrSize.files) big.push(`estimated ${c.estimatedFiles} files > limit ${maxPrSize.files}`);
  if (c.estimatedLines > maxPrSize.lines) big.push(`estimated ${c.estimatedLines} lines > limit ${maxPrSize.lines}`);
  if (c.estimatedTasks > MAX_PLAN_TASKS) big.push(`estimated ${c.estimatedTasks} plan tasks > limit ${MAX_PLAN_TASKS}`);
  if (c.independentSubsystems) big.push('spans independent subsystems that could ship separately');
  if (big.length) return result('too-big', big);
  if (!c.claudeGo) {
    const fork = [];
    if (c.changesUserVisibleBehaviourNotInIssue) fork.push('changes user-visible behaviour the issue does not describe');
    if (c.changesDataModelApiAuthOrDeps) fork.push('changes the data model, a public API, auth or security, or adds a dependency');
    if (c.assumptions.length > MAX_ASSUMPTIONS) fork.push(`${c.assumptions.length} assumptions > limit ${MAX_ASSUMPTIONS}`);
    if (!c.acceptanceCriteriaDerivable) fork.push('no acceptance criteria can be stated or derived');
    if (fork.length) return result('fork', fork);
  }
  if (kept.length && !c.waitOverride) {
    return result('wait', kept.map((key) => `overlaps ${runLabel(key)}, a run ahead of this one`), {
      waitFor: kept,
      waitLine: `Waiting for: ${kept.join(', ')}`,
    });
  }
  if (kept.length) notes.push(`went ahead alongside ${kept.map(runLabel).join(', ')}`);
  if (c.assumptions.length) return result('small-gaps', [`${c.assumptions.length} assumption(s) to record`]);
  return result('ready', []);
}
