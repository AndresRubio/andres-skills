import { ghJson, fetchPrComments, fetchRunJson } from './github.mjs';
import { isPipelineBranch, keyFromBranch } from './naming.mjs';
import { issueNumberFromBody } from './ready.mjs';
import { isVerdictAuthor, parseVerdictBody } from './verdict.mjs';
import { latestScore } from './score.mjs';

export const PR_LIMIT = 500;

export function realMetricsDeps(repo) {
  return {
    // gh pr list returns newest first. `gh pr list --search` works together with `--state all`, so a --since date
    // narrows the query on the server and the 500-PR window starts at that date instead of today.
    listPrs: ({ since } = {}) => ghJson(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(PR_LIMIT), ...(since ? ['--search', `created:>=${since}`] : []), '--json', 'number,headRefName,headRefOid,isCrossRepository,state,createdAt,closedAt,mergedAt,body']),
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

const warnToStderr = (message) => process.stderr.write(`${JSON.stringify({ warning: message })}\n`);

// The rows array also carries `truncated`, `skipped` and `errors`; aggregate copies them into the repo result.
export function collectRows(repo, { since } = {}, deps = realMetricsDeps(repo)) {
  const sinceMs = since === undefined || since === null ? null : Date.parse(since);
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error('--since must be an ISO date');
  const warn = deps.warn ?? warnToStderr;
  const all = deps.listPrs({ since: sinceMs === null ? null : new Date(sinceMs).toISOString().slice(0, 10) });
  const truncated = all.length >= PR_LIMIT;
  if (truncated) warn(`${repo}: pr list hit the ${PR_LIMIT} limit; older PRs are not counted`);
  const errors = [];
  const inScope = all.filter((p) => typeof p.headRefName === 'string' && p.headRefName.startsWith('pipeline/') && p.isCrossRepository !== true && (sinceMs === null || Date.parse(p.createdAt) >= sinceMs));
  // A pipeline/ branch without a pipeline key has no run.json and no issue; counting it would dilute the rates.
  const skipped = inScope.filter((p) => !isPipelineBranch(p.headRefName)).length;
  const rows = inScope
    .filter((p) => isPipelineBranch(p.headRefName))
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const key = keyFromBranch(p.headRefName);
      let prComments = [];
      let issueComments = [];
      let failed = false;
      try {
        prComments = deps.prComments(p.number);
        const issueNumber = issueNumberFromBody(p.body);
        issueComments = issueNumber ? deps.issueComments(issueNumber) : [];
      } catch (e) {
        failed = true;
        errors.push(`PR #${p.number}: ${e?.message ?? e}`);
        prComments = [];
        issueComments = [];
      }
      let runs = [];
      try { runs = plainRuns(deps.runJson(p.headRefOid, key)); } catch (e) { errors.push(`PR #${p.number} run.json: ${e?.message ?? e}`); }
      const readyAt = prComments.filter((c) => isPipeline(c, 'ready')).map((c) => c.createdAt).filter((t) => !Number.isNaN(Date.parse(t))).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
      // ready-run posts blocked on the PR itself when there is no linked issue, and Linear-lane runs have no issue number.
      const asked = (cs) => cs.some((c) => isPipeline(c, 'questions') || isPipeline(c, 'blocked'));
      const decision = !failed && (asked(issueComments) || asked(prComments)
        || prComments.some((c) => isPipeline(c, 'verdict') && isVerdictAuthor(c) && parseVerdictBody(c.body)?.verdict === 'human-decision-needed'));
      const score = failed ? null : latestScore(prComments);
      return {
        key,
        pr: { number: p.number, readyAt, mergedAt: p.mergedAt ?? null, closedAt: p.state === 'CLOSED' ? (p.closedAt ?? null) : null },
        runs,
        decision,
        score: score && { taskCompliance: score.taskCompliance, reviewQuality: score.reviewQuality },
      };
    });
  return Object.assign(rows, { truncated, skipped, errors });
}
