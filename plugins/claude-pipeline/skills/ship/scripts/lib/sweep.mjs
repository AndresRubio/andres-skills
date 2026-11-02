// The GitHub lane's sweep (spec §8.1, Phase 2b): which waiting, deferred or crashed issues to start
// again, oldest first, up to the free slots. Pure: the caller fetches, this decides.
import { activeRuns, latestDecision } from './runs.mjs';
import { checkEligibility } from './eligibility.mjs';
import { isPipelineComment, lockStatus } from './lock.mjs';

// Counting every run in progress needs a "self" that holds no lock and has no relations.
const NOBODY = Object.freeze({ number: 0, labels: [], comments: [], openSubIssues: [] });

const ownsBranch = (n, name) => name === `claude/${n}` || name.startsWith(`claude/${n}-`);

export function sweepReason(issue, { config, now = new Date() }) {
  if (latestDecision(issue)?.marker.kind === 'deferred') return 'deferred';
  if (!issue.comments.some(isPipelineComment)) return 'new';
  const lock = lockStatus(issue, { ttlHours: config.lockTtlHours, now });
  if (lock.locked && lock.stale) return 'stale-lock';
  return null;
}

// The event route (lane.mjs, issues/labeled) starts a run only when the person who added the
// `claude` label is the issue's author or the repo owner. The sweep applies the same rule to an
// issue no run has touched yet; issue.labeledBy is that person's login, put there by sweep-run.
// No known labeller, or no owner given, never matches: it fails closed.
export function labelSenderTrusted(issue, owner) {
  const sender = issue.labeledBy;
  if (!sender) return false;
  return sender === issue.author || (Boolean(owner) && sender === owner);
}

const byAge = (a, b) => {
  if (a.createdAt !== b.createdAt) return (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1;
  return a.number - b.number;
};

export function sweepCandidates({ issues, prs, closedPrs, config, owner = null, now = new Date() }) {
  const unique = [...new Map(issues.map((i) => [i.number, i])).values()];
  const lockedIssues = unique.filter((i) => i.labels.includes('claude-working'));
  const common = { prs, lockedIssues, ttlHours: config.lockTtlHours, maxParallel: config.maxParallel, now };
  const inProgress = activeRuns({ ...common, selfIssue: NOBODY }).runs.length;
  const slots = Math.max(0, config.maxParallel - inProgress);
  const start = [];
  const skipped = [];
  for (const issue of unique.filter((i) => i.state === 'open' && i.labels.includes('claude')).sort(byAge)) {
    const reason = sweepReason(issue, { config, now });
    if (!reason) continue; // an event starts it, or it is done
    const skip = (why) => skipped.push({ issue: issue.number, reason, why });
    if (reason === 'new' && !labelSenderTrusted(issue, owner)) { skip('label sender is not the issue author or the repo owner'); continue; }
    if (prs.some((p) => p.isCrossRepository !== true && ownsBranch(issue.number, p.headRefName))) { skip('has an open claude/* PR'); continue; }
    const lastReport = issue.comments
      .filter((c) => isPipelineComment(c) && c.marker.kind === 'report')
      .map((c) => c.createdAt).sort().at(-1) ?? '';
    const rejected = closedPrs.find((p) => p.isCrossRepository !== true && !p.mergedAt && ownsBranch(issue.number, p.headRefName) && p.closedAt > lastReport);
    if (rejected) { skip(`PR #${rejected.number} was closed unmerged`); continue; }
    if (start.length >= slots) { skip('no free slot'); continue; }
    const eligibility = checkEligibility({ issue, config, lane: 'github', activeRuns: activeRuns({ ...common, selfIssue: issue }), now });
    if (!eligibility.eligible) { skip(eligibility.reasons.join('; ')); continue; }
    start.push(issue.number);
  }
  return { inProgress, slots, start, skipped };
}
