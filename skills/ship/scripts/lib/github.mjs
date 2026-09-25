import { execFileSync } from 'node:child_process';
import { parseMarker } from './marker.mjs';
import { isPipelineComment, TRUSTED } from './lock.mjs';

export function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

export function currentRepo(gh = ghJson) {
  return gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
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
    comments: apiComments.map((c) => {
      const comment = {
        id: c.id,
        author: c.user?.login ?? null,
        authorAssociation: c.author_association,
        body: c.body ?? '',
        createdAt: c.created_at,
        marker: parseMarker(c.body),
      };
      return { ...comment, pipeline: isPipelineComment(comment), trusted: TRUSTED.has(comment.authorAssociation) };
    }),
  };
}

export function fetchIssue(repo, number, gh = ghJson) {
  const issue = gh(['api', `repos/${repo}/issues/${number}`]);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`]).flat();
  const blockedBy = gh(['api', `repos/${repo}/issues/${number}/dependencies/blocked_by`]);
  const subIssues = gh(['api', `repos/${repo}/issues/${number}/sub_issues`]);
  return normalizeIssue(issue, comments, { blockedBy, subIssues });
}

// Fails closed: a claude/* PR counts unless it's known to be from a fork
// (isCrossRepository === true). If gh ever omits the field, treat it as ours
// rather than silently undercounting open runs against maxParallel.
export function countOpenClaudePrs(prs) {
  return prs.filter((p) => typeof p.headRefName === 'string' && p.headRefName.startsWith('claude/') && p.isCrossRepository !== true).length;
}
