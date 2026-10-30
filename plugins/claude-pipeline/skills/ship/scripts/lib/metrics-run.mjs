import { ghJson, fetchPrComments, fetchRunJson } from './github.mjs';
import { keyFromBranch } from './naming.mjs';
import { issueNumberFromBody } from './ready.mjs';
import { isVerdictAuthor, parseVerdictBody } from './verdict.mjs';
import { latestScore } from './score.mjs';

export function realMetricsDeps(repo) {
  return {
    listPrs: () => ghJson(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '500', '--json', 'number,headRefName,headRefOid,isCrossRepository,state,createdAt,closedAt,mergedAt,body']),
    // The contents API reads a merged or closed PR's head by sha, even after its branch is deleted.
    runJson: (sha, key) => fetchRunJson(repo, sha, key),
    prComments: (n) => fetchPrComments(repo, n),
    // fetchPrComments reads repos/<repo>/issues/<n>/comments, which GitHub serves for issues and PRs alike.
    issueComments: (n) => fetchPrComments(repo, n),
  };
}

const isPipeline = (c, kind) => c.pipeline && c.marker?.kind === kind;

// run.json is editable by anyone who can push to the branch: only plain-object entries of runs are kept.
const plainRuns = (data) => (data !== null && typeof data === 'object' && Array.isArray(data.runs) ? data.runs.filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r)) : []);

export function collectRows(repo, { since } = {}, deps = realMetricsDeps(repo)) {
  const sinceMs = since === undefined || since === null ? null : Date.parse(since);
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error('--since must be an ISO date');
  return deps.listPrs()
    .filter((p) => typeof p.headRefName === 'string' && p.headRefName.startsWith('claude/') && p.isCrossRepository !== true && (sinceMs === null || Date.parse(p.createdAt) >= sinceMs))
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      let key = null;
      try { key = keyFromBranch(p.headRefName); } catch { /* a claude/ branch without a pipeline key has no run.json to read */ }
      const prComments = deps.prComments(p.number);
      const issueNumber = issueNumberFromBody(p.body);
      const issueComments = issueNumber ? deps.issueComments(issueNumber) : [];
      const readyAt = prComments.filter((c) => isPipeline(c, 'ready')).map((c) => c.createdAt).filter((t) => !Number.isNaN(Date.parse(t))).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
      const decision = issueComments.some((c) => isPipeline(c, 'questions') || isPipeline(c, 'blocked'))
        || prComments.some((c) => isPipeline(c, 'verdict') && isVerdictAuthor(c) && parseVerdictBody(c.body)?.verdict === 'human-decision-needed');
      const score = latestScore(prComments);
      return {
        key: key ?? `PR-${p.number}`,
        pr: { number: p.number, readyAt, mergedAt: p.mergedAt ?? null, closedAt: p.state === 'CLOSED' ? (p.closedAt ?? null) : null },
        runs: key === null ? [] : plainRuns(deps.runJson(p.headRefOid, key)),
        decision,
        score: score && { taskCompliance: score.taskCompliance, reviewQuality: score.reviewQuality },
      };
    });
}
