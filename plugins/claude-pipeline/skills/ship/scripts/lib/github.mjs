import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarker } from './marker.mjs';
import { isPipelineComment, TRUSTED } from './lock.mjs';
import { activeRuns } from './runs.mjs';

export function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

export function currentRepo(gh = ghJson) {
  return gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
}

// gh commands whose output isn't JSON (pr edit, pr comment, issue edit…). Returns trimmed stdout.
export function ghText(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function normalizeComments(apiComments) {
  return apiComments.map((c) => {
    const comment = { id: c.id, author: c.user?.login ?? null, authorAssociation: c.author_association, body: c.body ?? '', createdAt: c.created_at, marker: parseMarker(c.body) };
    return { ...comment, pipeline: isPipelineComment(comment), trusted: TRUSTED.has(comment.authorAssociation) };
  });
}

export function fetchPrComments(repo, number, gh = ghJson) {
  return normalizeComments(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`]).flat());
}

export const PR_FIELDS = 'number,url,title,body,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,labels,mergeable,mergeStateStatus,statusCheckRollup,author';

export function fetchPr(repo, number, gh = ghJson) {
  const pr = gh(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]);
  return { ...pr, labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)) };
}

// Posts a comment body through a file (free text never goes on a command line). Tests set
// CLAUDE_PIPELINE_BODY_FILE so the fake gh sees a stable path.
export function postPrComment(repo, number, body, gh = ghText, env = process.env) {
  const file = env.CLAUDE_PIPELINE_BODY_FILE || path.join(mkdtempSync(path.join(tmpdir(), 'cp-body-')), 'body.md');
  writeFileSync(file, body);
  return gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', file]);
}

export function postIssueComment(repo, number, body, gh = ghText, env = process.env) {
  const file = env.CLAUDE_PIPELINE_BODY_FILE || path.join(mkdtempSync(path.join(tmpdir(), 'cp-body-')), 'body.md');
  writeFileSync(file, body);
  return gh(['issue', 'comment', String(number), '--repo', repo, '--body-file', file]);
}

export function normalizeIssue(apiIssue, apiComments, { blockedBy = [], subIssues = [] } = {}) {
  return {
    number: apiIssue.number,
    id: apiIssue.id,
    nodeId: apiIssue.node_id,
    title: apiIssue.title,
    body: apiIssue.body ?? '',
    state: apiIssue.state,
    url: apiIssue.html_url,
    author: apiIssue.user?.login ?? null,
    authorAssociation: apiIssue.author_association,
    isPullRequest: Boolean(apiIssue.pull_request),
    labels: (apiIssue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    openBlockedBy: blockedBy.filter((i) => i.state === 'open').map((i) => i.number),
    openSubIssues: subIssues.filter((i) => i.state === 'open').map((i) => i.number),
    comments: normalizeComments(apiComments),
  };
}

export function fetchIssue(repo, number, gh = ghJson) {
  const issue = gh(['api', `repos/${repo}/issues/${number}`]);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`]).flat();
  const blockedBy = gh(['api', `repos/${repo}/issues/${number}/dependencies/blocked_by`]);
  const subIssues = gh(['api', `repos/${repo}/issues/${number}/sub_issues`]);
  return normalizeIssue(issue, comments, { blockedBy, subIssues });
}

// Runs in progress for issue selfNumber (spec D16): open PRs, then every open issue
// labelled claude-working, each fetched in full, then the issue itself.
export function fetchActiveRuns(repo, selfNumber, { ttlHours, maxParallel, now = new Date() }, gh = ghJson) {
  const prs = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,headRefName,isCrossRepository,title']);
  const listed = gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', 'claude-working', '--limit', '500', '--json', 'number']);
  const numbers = [...new Set(listed.map((i) => i.number))].filter((n) => n !== selfNumber);
  const lockedIssues = numbers.map((n) => fetchIssue(repo, n, gh));
  const selfIssue = fetchIssue(repo, selfNumber, gh);
  return activeRuns({ prs, lockedIssues, selfIssue, ttlHours, maxParallel, now });
}
