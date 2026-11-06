import { ghJson, ghText, fetchIssue } from './github.mjs';
import { sweepCandidates } from './sweep.mjs';
import { isPipelineComment } from './lock.mjs';

// Login of whoever added `label` last, from the issue's events. The API returns them oldest first,
// but the order is not relied on: events are sorted by created_at (a stable sort, so ties keep the
// API order). Null when unknown.
export function latestLabeler(events, label) {
  const at = (e) => (typeof e.created_at === 'string' ? e.created_at : '');
  const labeled = events.filter((e) => e?.event === 'labeled' && e.label?.name === label).sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
  return labeled.at(-1)?.actor?.login ?? null;
}

const errorText = (err) => String(err?.stderr || err?.message || err).trim();

export function realSweepDeps(repo) {
  return {
    listIssueNumbers: (label) => ghJson(['issue', 'list', '--repo', repo, '--state', 'open', '--label', label, '--limit', '500', '--json', 'number']).map((i) => i.number),
    owner: repo.split('/')[0],
    fetchIssue: (n) => fetchIssue(repo, n),
    fetchLabeledBy: (n) => latestLabeler(ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues/${n}/events`]).flat(), 'pipeline'),
    listOpenPrs: () => ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,headRefName,isCrossRepository,title']),
    listClosedPrs: () => ghJson(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--json', 'number,headRefName,isCrossRepository,state,closedAt,mergedAt'])
      .filter((p) => p.state !== 'OPEN'),
    // GITHUB_TOKEN may start workflows only through workflow_dispatch (and repository_dispatch).
    dispatch: (n) => ghText(['workflow', 'run', 'pipeline-ship.yml', '--repo', repo, '-f', `issue=${n}`]),
  };
}

export function runSweep({ config, now = new Date(), dryRun = false }, deps) {
  if (config.enabled === false) return { started: [], skipped: [], errors: [], disabled: true };
  const numbers = [...new Set([...deps.listIssueNumbers('pipeline'), ...deps.listIssueNumbers('pipeline-working')])];
  const started = [];
  const errors = [];
  // One issue that cannot be fetched is an error entry; the rest of the sweep goes on.
  const issues = [];
  for (const n of numbers) {
    try {
      const issue = deps.fetchIssue(n);
      // Only an issue no run has touched is judged by who labelled it; the others have a pipeline comment.
      const untouched = issue.state === 'open' && issue.labels.includes('pipeline') && !issue.comments.some(isPipelineComment);
      issues.push(untouched ? { ...issue, labeledBy: deps.fetchLabeledBy ? deps.fetchLabeledBy(n) : null } : issue);
    } catch (err) {
      errors.push({ issue: n, error: errorText(err) });
    }
  }
  const result = sweepCandidates({ issues, prs: deps.listOpenPrs(), closedPrs: deps.listClosedPrs(), config, owner: deps.owner ?? null, now });
  for (const issue of result.start) {
    if (dryRun) { started.push({ issue, done: 'would dispatch pipeline-ship' }); continue; }
    try {
      deps.dispatch(issue);
      started.push({ issue, done: 'dispatched pipeline-ship' });
    } catch (err) {
      errors.push({ issue, error: errorText(err) });
    }
  }
  return { inProgress: result.inProgress, slots: result.slots, started, skipped: result.skipped, errors };
}
