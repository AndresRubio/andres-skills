import { ghJson, ghText, fetchIssue } from './github.mjs';
import { sweepCandidates } from './sweep.mjs';

export function realSweepDeps(repo) {
  return {
    listIssueNumbers: (label) => ghJson(['issue', 'list', '--repo', repo, '--state', 'open', '--label', label, '--limit', '500', '--json', 'number']).map((i) => i.number),
    fetchIssue: (n) => fetchIssue(repo, n),
    listOpenPrs: () => ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,headRefName,isCrossRepository,title']),
    listClosedPrs: () => ghJson(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--json', 'number,headRefName,isCrossRepository,state,closedAt,mergedAt'])
      .filter((p) => p.state !== 'OPEN'),
    // GITHUB_TOKEN may start workflows only through workflow_dispatch (and repository_dispatch).
    dispatch: (n) => ghText(['workflow', 'run', 'claude-ship.yml', '--repo', repo, '-f', `issue=${n}`]),
  };
}

export function runSweep({ config, now = new Date(), dryRun = false }, deps) {
  if (config.enabled === false) return { started: [], skipped: [], errors: [], disabled: true };
  const numbers = [...new Set([...deps.listIssueNumbers('claude'), ...deps.listIssueNumbers('claude-working')])];
  const issues = numbers.map((n) => deps.fetchIssue(n));
  const result = sweepCandidates({ issues, prs: deps.listOpenPrs(), closedPrs: deps.listClosedPrs(), config, now });
  const started = [];
  const errors = [];
  for (const issue of result.start) {
    if (dryRun) { started.push({ issue, done: 'would dispatch claude-ship' }); continue; }
    try {
      deps.dispatch(issue);
      started.push({ issue, done: 'dispatched claude-ship' });
    } catch (err) {
      errors.push({ issue, error: String(err.stderr || err.message).trim() });
    }
  }
  return { inProgress: result.inProgress, slots: result.slots, started, skipped: result.skipped, errors };
}
