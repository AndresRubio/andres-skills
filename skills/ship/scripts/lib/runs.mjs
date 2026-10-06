// Runs in progress (spec D16, §8.1): which runs count against maxParallel, which of
// them are ahead of this one, and which runs a waiting issue is waiting for.
import { isPipelineComment, TRUSTED, PIPELINE_BOTS } from './lock.mjs';
import { keyFromBranch } from './naming.mjs';

// A comment of one of these kinds ends the run that the lock before it started.
export const RELEASING_KINDS = Object.freeze(['report', 'blocked', 'questions', 'split', 'deferred', 'stale-lock']);
// The latest comment of one of these kinds is the issue's current decision.
export const DECISION_KINDS = Object.freeze(['grade', 'questions', 'split', 'report', 'blocked', 'deferred']);
export const KEY_RE = /^(\d+|[a-z][a-z0-9]*-\d+|pr-\d+)$/;

const BRANCH_RE = /branch `(claude\/[A-Za-z0-9._\/-]+)`/;
const WAIT_LINE_RE = /^Waiting for: (.+)$/;

const NO_LOCK = Object.freeze({ lockedAt: null, lockId: null, branch: null });

function pipelineComments(issue, kinds) {
  return issue.comments.filter((c) => isPipelineComment(c) && kinds.includes(c.marker.kind));
}

// When this issue's current run started: the first fresh lock comment after its latest
// releasing comment. Comments are ordered by id, never by time.
export function runLock(issue, { ttlHours, now = new Date() }) {
  if (!issue.labels.includes('claude-working')) return { state: 'none', ...NO_LOCK };
  const released = Math.max(-Infinity, ...pipelineComments(issue, RELEASING_KINDS).map((c) => c.id));
  const candidates = pipelineComments(issue, ['lock']).filter((c) => c.id > released);
  const nowMs = new Date(now).getTime();
  const fresh = candidates.filter((c) => nowMs - new Date(c.createdAt).getTime() <= ttlHours * 3_600_000);
  if (!fresh.length) return { state: candidates.length ? 'none' : 'entering', ...NO_LOCK };
  const lock = fresh.reduce((a, b) => (b.id < a.id ? b : a));
  return { state: 'locked', lockedAt: lock.createdAt, lockId: lock.id, branch: lock.body.match(BRANCH_RE)?.[1] ?? null };
}

export function compareKeys(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

// The keys of the runs this issue waits for: the last line of its latest decision
// comment, when that comment is a `deferred`.
export function waitingFor(issue) {
  const decision = pipelineComments(issue, DECISION_KINDS).reduce((a, b) => (a === null || b.id > a.id ? b : a), null);
  if (decision?.marker.kind !== 'deferred') return [];
  const last = decision.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  const m = last.match(WAIT_LINE_RE);
  if (!m) return [];
  return [...new Set(m[1].split(',').map((key) => key.trim()).filter((key) => KEY_RE.test(key)))];
}

// Runs without a PR, by when their lock was taken.
function compareLocks(a, b) {
  if (a.lockedAt !== b.lockedAt) return a.lockedAt < b.lockedAt ? -1 : 1;
  if (a.lockId !== b.lockId) return a.lockId - b.lockId;
  return compareKeys(a.key, b.key);
}

function compareRuns(a, b) {
  if ((a.pr !== null) !== (b.pr !== null)) return a.pr !== null ? -1 : 1;
  return a.pr !== null ? a.pr - b.pr : compareLocks(a, b);
}

function prKey(pr) {
  try {
    return keyFromBranch(pr.headRefName);
  } catch {
    return `pr-${pr.number}`;
  }
}

export function activeRuns({ prs, lockedIssues, selfIssue, ttlHours, maxParallel, now = new Date() }) {
  const byKey = new Map();

  // Fails closed: a claude/* PR counts unless it's known to be from a fork.
  for (const pr of prs) {
    if (typeof pr.headRefName !== 'string' || !pr.headRefName.startsWith('claude/') || pr.isCrossRepository === true) continue;
    const key = prKey(pr);
    if (byKey.has(key) && byKey.get(key).pr <= pr.number) continue;
    const issue = /^\d+$/.test(key) ? Number(key) : null;
    byKey.set(key, {
      key, issue, pr: pr.number, branch: pr.headRefName, title: pr.title, body: null, textWithheld: false,
      lockedAt: null, lockId: null, related: selfIssue.openSubIssues.includes(issue),
    });
  }

  for (const issue of lockedIssues) {
    if (issue.state !== 'open') continue;
    const lock = runLock(issue, { ttlHours, now });
    if (lock.state !== 'locked') continue;
    const key = String(issue.number);
    const related = issue.openSubIssues.includes(selfIssue.number) || selfIssue.openSubIssues.includes(issue.number);
    const run = byKey.get(key);
    if (run) {
      if (run.pr === null) continue;
      run.lockedAt = lock.lockedAt;
      run.lockId = lock.lockId;
      run.related ||= related;
      continue;
    }
    const readable = TRUSTED.has(issue.authorAssociation) || PIPELINE_BOTS.has(issue.author);
    byKey.set(key, {
      key, issue: issue.number, pr: null, branch: lock.branch,
      title: readable ? issue.title : null, body: readable ? issue.body : null, textWithheld: !readable,
      lockedAt: lock.lockedAt, lockId: lock.lockId, related,
    });
  }

  const selfKey = String(selfIssue.number);
  const selfLock = runLock(selfIssue, { ttlHours, now });
  const self = selfLock.state === 'locked'
    ? { key: selfKey, lockedAt: selfLock.lockedAt, lockId: selfLock.lockId }
    : { key: selfKey, lockedAt: null, lockId: null };

  const runs = [...byKey.values()].filter((r) => r.key !== selfKey).sort(compareRuns);
  const ahead = runs
    .filter((r) => self.lockedAt === null || r.pr !== null || compareLocks(r, self) < 0)
    .map((r) => r.key);
  return { self, runs, ahead, maxParallel, admitted: ahead.length < maxParallel };
}
