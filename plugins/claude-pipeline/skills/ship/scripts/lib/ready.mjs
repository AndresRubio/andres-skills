import { keyFromBranch } from './naming.mjs';

const FAILURE_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED']);
const FAILURE_STATES = new Set(['ERROR', 'FAILURE']);
export const REVIEW_CHECK = 'claude-review';

// When an entry happened: completedAt (else startedAt) for a check run, createdAt for a status
// context. gh prints the zero time (0001-01-01) for a run that hasn't completed, so only real
// dates count. No timestamp ranks oldest.
function entryTime(e) {
  const fields = e.__typename === 'StatusContext' ? [e.createdAt, e.startedAt] : [e.completedAt, e.startedAt];
  for (const value of fields) {
    const ms = value ? new Date(value).getTime() : NaN;
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return -Infinity;
}

// The rollup keeps every run of a check for the commit (re-runs, other suites), so only the
// newest entry for the name is judged; entries tied for newest (or all without a timestamp)
// fall back to: any failure wins, then any pending.
export function checkState(rollup, name) {
  const all = (rollup ?? []).filter((e) => (e.__typename === 'StatusContext' ? e.context : e.name) === name);
  if (all.length === 0) return 'missing';
  const newest = Math.max(...all.map(entryTime));
  const entries = all.filter((e) => entryTime(e) === newest);
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
  // A stale label never survives a head that is no longer verified green (spec 6.3).
  const stale = hasReady ? { removeReady: true } : {};
  const review = checkState(pr.statusCheckRollup, REVIEW_CHECK);
  if (review === 'failure' || (review === 'success' && verdict?.verdict !== 'accepted')) {
    if (!verdict) return { action: 'needs-decision', reason: 'no verdict comment for this head SHA', findings: [], ...stale };
    if (verdict.verdict === 'human-decision-needed') return { action: 'needs-decision', reason: 'review: human decision needed', findings: verdict.findings.filter((f) => f.kind === 'judgment'), ...stale };
    return { action: 'fix', reason: 'review', ...stale };
  }
  const failing = config.ciChecks.filter((name) => checkState(pr.statusCheckRollup, name) === 'failure');
  if (failing.length) return { action: 'fix', reason: 'ci', failing, ...stale };
  const notDone = [...config.ciChecks, REVIEW_CHECK].filter((name) => checkState(pr.statusCheckRollup, name) !== 'success');
  if (notDone.length) return { action: 'wait', reason: `not success yet: ${notDone.join(', ')}`, ...stale };
  // GitHub computes mergeability lazily; UNKNOWN (common right after the base moves) is not "clean".
  if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN') return { action: 'wait', reason: 'merge state not computed yet', ...stale };
  if (pr.mergeStateStatus === 'BEHIND') return { action: 'update', reason: 'behind base', ...stale };
  if (pr.mergeable === 'CONFLICTING') return { action: 'fix', reason: 'conflict', ...stale };
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
