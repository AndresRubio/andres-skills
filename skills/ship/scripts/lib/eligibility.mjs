import { lockStatus, TRUSTED, isPipelineComment } from './lock.mjs';
import { waitingFor } from './runs.mjs';

export { TRUSTED };

export const LANES = Object.freeze(['manual', 'github', 'linear', 'local']);

// These pipeline comments ask nothing new, so a reply older than them is still new.
const ASKS_NOTHING = new Set(['lock', 'deferred', 'stale-lock', 'reminder']);

export function hasNewTrustedReply(issue) {
  const lastMarked = issue.comments
    .filter((c) => isPipelineComment(c) && !ASKS_NOTHING.has(c.marker.kind))
    .map((c) => c.createdAt)
    .sort()
    .at(-1) ?? '';
  return issue.comments.some((c) => !c.marker && TRUSTED.has(c.authorAssociation) && c.createdAt > lastMarked);
}

export function checkEligibility({ issue, config, lane, activeRuns, now = new Date() }) {
  if (!LANES.includes(lane)) throw new Error(`unknown lane: ${lane}`);
  const reasons = [];
  const lock = lockStatus(issue, { ttlHours: config.lockTtlHours, now });
  if (!config.enabled) reasons.push('pipeline disabled (enabled=false)');
  if (lock.locked && !lock.stale) reasons.push(`locked since ${lock.since}`);
  if (lane === 'manual') return { eligible: reasons.length === 0, reasons, lock };
  if (!activeRuns) throw new Error('activeRuns is required for automatic lanes');
  if (activeRuns.self.key !== String(issue.number)) {
    throw new Error(`active runs were counted for #${activeRuns.self.key}, not #${issue.number}`);
  }

  const labels = new Set(issue.labels);
  if (issue.isPullRequest) reasons.push('is a pull request, not an issue');
  if (issue.state !== 'open') reasons.push(`state is ${issue.state}`);
  if (!labels.has('claude')) reasons.push('missing label claude');
  if (!TRUSTED.has(issue.authorAssociation)) {
    reasons.push(`author ${issue.author} is not trusted (${issue.authorAssociation})`);
  }
  const needsLocal = labels.has('needs-local');
  if (lane === 'local' && !needsLocal) reasons.push('the local lane takes only needs-local issues');
  if (lane !== 'local' && needsLocal) reasons.push('needs-local issues run only on the local lane');
  if (issue.openBlockedBy.length) reasons.push(`blocked by #${issue.openBlockedBy.join(', #')}`);
  if (issue.openSubIssues.length) reasons.push('parent with open sub-issues');
  if (!activeRuns.admitted) reasons.push(`maxParallel reached (${activeRuns.ahead.length}/${activeRuns.maxParallel})`);
  const inProgress = new Set(activeRuns.runs.map((r) => r.key));
  // claude-go lifts a wait: the grade then goes ahead alongside those runs (waitOverride).
  const waiting = labels.has('claude-go') ? [] : waitingFor(issue).filter((key) => inProgress.has(key));
  if (waiting.length) reasons.push(`waiting for ${waiting.join(', ')} (still in progress)`);
  if (labels.has('needs-decision') && !labels.has('claude-go') && !hasNewTrustedReply(issue)) {
    reasons.push('needs-decision with no new reply');
  }
  return { eligible: reasons.length === 0, reasons, lock };
}
