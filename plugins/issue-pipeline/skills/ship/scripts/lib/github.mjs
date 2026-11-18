import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarker } from './marker.mjs';
import { isPipelineComment, PIPELINE_BOTS, TRUSTED } from './lock.mjs';
import { splitInto } from './split.mjs';
import { activeRuns } from './runs.mjs';

// With a token, this one call runs with it as GH_TOKEN. Without one, gh keeps the authentication it has.
export function ghJson(args, { token } = {}) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env });
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

// API path of docs/pipeline/<key>/run.json at a commit. The key comes from a branch name or a PR, so it
// is checked as a raw single segment (letters, digits, ".", "_", "-", starting with a letter or digit,
// and not "." or "..") and then percent-encoded. The ref must be a hex SHA. Anything else is null.
export function runJsonPath(repo, sha, key) {
  try {
    const segment = String(key);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === '.' || segment === '..') return null;
    if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) return null;
    return `repos/${repo}/contents/docs/pipeline/${encodeURIComponent(segment)}/run.json?ref=${sha}`;
  } catch {
    return null;
  }
}

// run.json at a commit, parsed. Null on a bad path, a failed call, a file over 1 MB (the contents API
// then returns an empty content) or text that is not JSON: callers treat a run with no record as normal.
export function fetchRunJson(repo, sha, key, gh = ghJson) {
  try {
    const apiPath = runJsonPath(repo, sha, key);
    if (!apiPath) return null;
    const file = gh(['api', apiPath]);
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// owner/name as GitHub spells it. Checked before a --repo value reaches a gh argument or an API path.
export function isRepoSlug(repo) {
  return typeof repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repo) && !repo.endsWith('/.') && !repo.endsWith('/..');
}

export const PR_FIELDS = 'number,url,title,body,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,labels,mergeable,mergeStateStatus,author';
// The checks are read apart from the other fields, so that one call can use its own token.
export const PR_CHECKS_FIELDS = `${PR_FIELDS},statusCheckRollup`;

function viewPr(repo, number, fields, gh) {
  const pr = gh(['pr', 'view', String(number), '--repo', repo, '--json', fields]);
  return { ...pr, labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)) };
}

export function fetchPr(repo, number, gh = ghJson) {
  return viewPr(repo, number, PR_FIELDS, gh);
}

export function fetchPrWithChecks(repo, number, gh = ghJson) {
  return viewPr(repo, number, PR_CHECKS_FIELDS, gh);
}

// Posts a comment body through a file (free text never goes on a command line). Tests set
// ISSUE_PIPELINE_BODY_FILE so the fake gh sees a stable path.
export function postPrComment(repo, number, body, gh = ghText, env = process.env) {
  const file = env.ISSUE_PIPELINE_BODY_FILE || path.join(mkdtempSync(path.join(tmpdir(), 'cp-body-')), 'body.md');
  writeFileSync(file, body);
  return gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', file]);
}

export function postIssueComment(repo, number, body, gh = ghText, env = process.env) {
  const file = env.ISSUE_PIPELINE_BODY_FILE || path.join(mkdtempSync(path.join(tmpdir(), 'cp-body-')), 'body.md');
  writeFileSync(file, body);
  return gh(['issue', 'comment', String(number), '--repo', repo, '--body-file', file]);
}

// Only the number is used, against the host gh talks to, so the URL's host is not checked. A GitHub
// Enterprise Server URL (/api/v3/...) gives null and fails closed.
// The number of the parent issue, only when GitHub's parent_issue_url names an issue of this repository.
export function parentNumber(repo, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.search !== '' || parsed.hash !== '') return null;
  const match = /\/issues\/([1-9][0-9]*)$/.exec(parsed.pathname);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && parsed.pathname === `/repos/${repo}/issues/${n}` ? n : null;
}

// The parent of an issue a pipeline bot wrote, with the sub-issues its split comment lists. Null for any other issue.
export function fetchSplitParent(repo, apiIssue, gh = ghJson) {
  if (!PIPELINE_BOTS.has(apiIssue.user?.login)) return null;
  const n = parentNumber(repo, apiIssue.parent_issue_url);
  if (n === null) return null;
  const parent = gh(['api', `repos/${repo}/issues/${n}`]);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${n}/comments`]).flat();
  return { number: n, authorAssociation: parent.author_association, splitInto: splitInto(normalizeComments(comments)) };
}

export function normalizeIssue(apiIssue, apiComments, { blockedBy = [], subIssues = [], parent = null } = {}) {
  return {
    number: apiIssue.number,
    id: apiIssue.id,
    nodeId: apiIssue.node_id,
    title: apiIssue.title,
    body: apiIssue.body ?? '',
    state: apiIssue.state,
    createdAt: apiIssue.created_at ?? null,
    url: apiIssue.html_url,
    author: apiIssue.user?.login ?? null,
    authorAssociation: apiIssue.author_association,
    isPullRequest: Boolean(apiIssue.pull_request),
    labels: (apiIssue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    openBlockedBy: blockedBy.filter((i) => i.state === 'open').map((i) => i.number),
    openSubIssues: subIssues.filter((i) => i.state === 'open').map((i) => i.number),
    comments: normalizeComments(apiComments),
    parent,
  };
}

export function fetchIssue(repo, number, gh = ghJson) {
  const issue = gh(['api', `repos/${repo}/issues/${number}`]);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`]).flat();
  const blockedBy = gh(['api', `repos/${repo}/issues/${number}/dependencies/blocked_by`]);
  const subIssues = gh(['api', `repos/${repo}/issues/${number}/sub_issues`]);
  return normalizeIssue(issue, comments, { blockedBy, subIssues, parent: fetchSplitParent(repo, issue, gh) });
}

// Runs in progress for issue selfNumber (spec D16): open PRs, then every open issue
// labelled pipeline-working, each fetched in full, then the issue itself.
export function fetchActiveRuns(repo, selfNumber, { ttlHours, maxParallel, now = new Date() }, gh = ghJson) {
  const prs = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,headRefName,isCrossRepository,title']);
  const listed = gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', 'pipeline-working', '--limit', '500', '--json', 'number']);
  const numbers = [...new Set(listed.map((i) => i.number))].filter((n) => n !== selfNumber);
  const lockedIssues = numbers.map((n) => fetchIssue(repo, n, gh));
  const selfIssue = fetchIssue(repo, selfNumber, gh);
  return activeRuns({ prs, lockedIssues, selfIssue, ttlHours, maxParallel, now });
}
