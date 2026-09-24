import { lockStatus, TRUSTED } from './lock.mjs';

export { TRUSTED };

export const LANES = Object.freeze(['manual', 'github', 'linear', 'local']);

export function hasNewTrustedReply(issue) {
  const lastMarked = issue.comments.filter((c) => c.marker && TRUSTED.has(c.authorAssociation)).map((c) => c.createdAt).sort().at(-1) ?? '';
  return issue.comments.some((c) => !c.marker && TRUSTED.has(c.authorAssociation) && c.createdAt > lastMarked);
}

export function checkEligibility({ issue, config, lane, openClaudePrs = 0, now = new Date() }) {
  if (!LANES.includes(lane)) throw new Error(`unknown lane: ${lane}`);
  const reasons = [];
  const lock = lockStatus(issue, { ttlHours: config.lockTtlHours, now });
  if (!config.enabled) reasons.push('pipeline disabled (enabled=false)');
  if (lock.locked && !lock.stale) reasons.push(`locked since ${lock.since}`);
  if (lane === 'manual') return { eligible: reasons.length === 0, reasons, lock };

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
  if (openClaudePrs >= config.maxParallel) reasons.push(`maxParallel reached (${openClaudePrs}/${config.maxParallel})`);
  if (labels.has('needs-decision') && !labels.has('claude-go') && !hasNewTrustedReply(issue)) {
    reasons.push('needs-decision with no new reply');
  }
  return { eligible: reasons.length === 0, reasons, lock };
}
