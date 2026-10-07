import { keyFromBranch } from './naming.mjs';

const FAILURE_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED']);
const FAILURE_STATES = new Set(['ERROR', 'FAILURE']);
export const REVIEW_CHECK = 'claude-review';

export function checkState(rollup, name) {
  const entries = (rollup ?? []).filter((e) => (e.__typename === 'StatusContext' ? e.context : e.name) === name);
  if (entries.length === 0) return 'missing';
  const states = entries.map((e) => {
    if (e.__typename === 'StatusContext') return FAILURE_STATES.has(e.state) ? 'failure' : e.state === 'SUCCESS' ? 'success' : 'pending';
    if (e.status && e.status !== 'COMPLETED') return 'pending';
    if (e.conclusion === 'SUCCESS') return 'success';
    return FAILURE_CONCLUSIONS.has(e.conclusion) ? 'failure' : 'pending';
  });
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  return 'success';
}

export function issueNumberFromBody(body) {
  const m = String(body ?? '').match(/\b(?:fixes|closes|resolves)\s+#(\d+)/i);
  return m ? Number(m[1]) : null;
}

export function matchesProtected(file, patterns) {
  return patterns.some((p) => {
    const re = p.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    return new RegExp(`^${re}$`).test(file);
  });
}

export function decideReady({ pr, config, verdict }) {
  if (pr.isDraft) return { action: 'skip', reason: 'draft' };
  if (pr.isCrossRepository) return { action: 'skip', reason: 'fork' };
  try {
    keyFromBranch(pr.headRefName);
  } catch {
    return { action: 'skip', reason: 'not a pipeline branch' };
  }
  const hasReady = pr.labels.includes('ready');
  const review = checkState(pr.statusCheckRollup, REVIEW_CHECK);
  if (review === 'failure' || (review === 'success' && verdict?.verdict !== 'accepted')) {
    if (!verdict) return { action: 'needs-decision', reason: 'no verdict comment for this head SHA', findings: [] };
    if (verdict.verdict === 'human-decision-needed') return { action: 'needs-decision', reason: 'review: human decision needed', findings: verdict.findings.filter((f) => f.kind === 'judgment') };
    return { action: 'fix', reason: 'review' };
  }
  const failing = config.ciChecks.filter((name) => checkState(pr.statusCheckRollup, name) === 'failure');
  if (failing.length) return { action: 'fix', reason: 'ci', failing };
  const notDone = [...config.ciChecks, REVIEW_CHECK].filter((name) => checkState(pr.statusCheckRollup, name) !== 'success');
  if (notDone.length) return { action: 'wait', reason: `not success yet: ${notDone.join(', ')}` };
  if (pr.mergeStateStatus === 'BEHIND') return { action: 'update', reason: 'behind base', removeReady: hasReady };
  if (pr.mergeable === 'CONFLICTING') return { action: 'fix', reason: 'conflict', removeReady: hasReady };
  if (hasReady) return { action: 'already-ready' };
  return { action: 'ready' };
}

export function readyReport({ pr, config, verdict, changedFiles, marker, runSummary }) {
  if (!verdict || typeof verdict.verdict !== 'string') throw new Error('readyReport needs a parsed verdict');
  const key = keyFromBranch(pr.headRefName);
  const repoUrl = pr.url.replace(/\/pull\/\d+.*$/, '');
  const blob = (file) => `${repoUrl}/blob/${pr.headRefOid}/docs/pipeline/${key}/${file}`;
  const checks = [...config.ciChecks, REVIEW_CHECK].map((name) => `- \`${name}\`: ${checkState(pr.statusCheckRollup, name)}`);
  const care = [];
  if (config.mergeDeploys) care.push('- Merging deploys (`mergeDeploys` is true).');
  for (const f of changedFiles) if (matchesProtected(f, config.protectedPathsEffective)) care.push(`- Protected path changed: \`${f}\``);
  for (const h of verdict?.diffRisk ?? []) care.push(`- Diff risk — ${h.rule}: \`${h.file}\` — ${h.detail}`);
  const lines = [
    marker, '',
    `**Ready to merge** at head \`${pr.headRefOid.slice(0, 7)}\`. Nothing in the pipeline merges; this PR is yours to merge.`, '',
    '## Verified', ...checks,
    `- Review: verdict \`${verdict.verdict}\`${verdict.run ? ` (${verdict.run})` : ''}`,
    '- Branch is up to date with the base and has no conflicts.', '',
    '## Review with care', ...(care.length ? care : ['Nothing flagged.']), '',
    '## Files on the branch',
    `- [spec.md](${blob('spec.md')}) · [evidence.md](${blob('evidence.md')}) · [screenshots](${repoUrl}/tree/${pr.headRefOid}/docs/pipeline/${key}/screenshots)`,
  ];
  if (runSummary) lines.push('', `Run: ${runSummary}`);
  lines.push('', 'If the base moves, this label is removed, the branch is updated and the checks run again.');
  return lines.join('\n');
}
