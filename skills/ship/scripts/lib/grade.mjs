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
  conflictsWithOpenClaudePr: 'boolean',
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
  for (const name of Object.keys(c)) if (!(name in CHECKLIST_FIELDS)) problems.push(`unknown field "${name}"`);
  if (problems.length) throw new Error(`invalid checklist: ${problems.join('; ')}`);
  return c;
}

export function gradeVerdict(checklist, { maxPrSize, mode }) {
  const c = validateChecklist(checklist);
  if (mode === 'auto' && c.needsWorkflowChanges) {
    return { verdict: 'fork', reasons: ['needs .github/workflows changes, which automatic lanes may not make'] };
  }
  if (c.missingValues.length) return { verdict: 'fork', reasons: c.missingValues.map((v) => `missing value: ${v}`) };
  const big = [];
  if (c.estimatedFiles > maxPrSize.files) big.push(`estimated ${c.estimatedFiles} files > limit ${maxPrSize.files}`);
  if (c.estimatedLines > maxPrSize.lines) big.push(`estimated ${c.estimatedLines} lines > limit ${maxPrSize.lines}`);
  if (c.estimatedTasks > MAX_PLAN_TASKS) big.push(`estimated ${c.estimatedTasks} plan tasks > limit ${MAX_PLAN_TASKS}`);
  if (c.independentSubsystems) big.push('spans independent subsystems that could ship separately');
  if (big.length) return { verdict: 'too-big', reasons: big };
  if (!c.claudeGo) {
    const fork = [];
    if (c.changesUserVisibleBehaviourNotInIssue) fork.push('changes user-visible behaviour the issue does not describe');
    if (c.changesDataModelApiAuthOrDeps) fork.push('changes the data model, a public API, auth or security, or adds a dependency');
    if (c.assumptions.length > MAX_ASSUMPTIONS) fork.push(`${c.assumptions.length} assumptions > limit ${MAX_ASSUMPTIONS}`);
    if (!c.acceptanceCriteriaDerivable) fork.push('no acceptance criteria can be stated or derived');
    if (c.conflictsWithOpenClaudePr) fork.push('conflicts with an open claude/* PR');
    if (fork.length) return { verdict: 'fork', reasons: fork };
  }
  if (c.assumptions.length) return { verdict: 'small-gaps', reasons: [`${c.assumptions.length} assumption(s) to record`] };
  return { verdict: 'ready', reasons: [] };
}
