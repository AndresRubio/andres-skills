import { ghJson, ghText, fetchPr, fetchPrComments, fetchIssue, postPrComment, postIssueComment } from './github.mjs';
import { latestVerdict } from './verdict.mjs';
import { decideReady, readyReport, issueNumberFromBody } from './ready.mjs';
import { formatMarker, defaultRun } from './marker.mjs';

export function realDeps(repo) {
  return {
    listPrs: () => ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,headRefName,isCrossRepository,isDraft']),
    fetchPr: (r, n) => fetchPr(r, n),
    fetchPrComments: (r, n) => fetchPrComments(r, n),
    fetchIssue: (r, n) => fetchIssue(r, n),
    changedFiles: (r, n) => ghJson(['api', '--paginate', '--slurp', `repos/${r}/pulls/${n}/files`]).flat().map((f) => f.filename),
    addLabel: (kind, n, label) => ghText([kind, 'edit', String(n), '--repo', repo, '--add-label', label]),
    removeLabel: (kind, n, label) => ghText([kind, 'edit', String(n), '--repo', repo, '--remove-label', label]),
    updateBranch: (n) => ghText(['api', '-X', 'PUT', `repos/${repo}/pulls/${n}/update-branch`]),
    comment: (kind, n, body) => (kind === 'pr' ? postPrComment(repo, n, body) : postIssueComment(repo, n, body)),
  };
}

function findingBlock(f, i) {
  const lines = [`### ${i + 1}. ${f.file}:${f.line} — ${f.problem}`, `**Impact:** ${f.impact}`, `**Correction:** ${f.correction}`];
  if (f.options?.length) lines.push(`**Options:** ${f.options.join(', ')}`);
  if (f.recommendation) lines.push(`**Recommendation:** ${f.recommendation}`);
  return lines.join('\n');
}

export function blockedBody({ pr, findings, reason, marker }) {
  const sha7 = pr.headRefOid.slice(0, 7);
  const parts = [marker, '', `Review verdict on PR #${pr.number}: human decision needed at head \`${sha7}\`.`, ''];
  if (findings.length) parts.push(findings.map(findingBlock).join('\n\n'), '');
  else parts.push(`Reason: ${reason}.`, '');
  parts.push(`Reply here with your decision; a fix run on PR #${pr.number} then applies it. Nothing is changed until you do.`);
  return parts.join('\n');
}

function alreadyBlockedForHead(issue, sha7) {
  return issue.comments.some((c) => c.pipeline && c.marker?.kind === 'blocked' && c.body.includes(`head \`${sha7}\``));
}

export async function runReady({ repo, config, now = new Date(), dryRun = false, run = defaultRun() }, deps = realDeps(repo)) {
  if (config.enabled === false) return { actions: [], disabled: true };
  const prs = deps.listPrs()
    .filter((p) => !p.isDraft && !p.isCrossRepository && p.headRefName.startsWith('claude/'))
    .sort((a, b) => a.number - b.number);
  const actions = [];
  for (const listed of prs) {
    const pr = deps.fetchPr(repo, listed.number);
    const verdict = latestVerdict(deps.fetchPrComments(repo, pr.number), pr.headRefOid);
    const decision = decideReady({ pr, config, verdict });
    const done = [];
    const act = (label, fn) => { done.push(dryRun ? `would ${label}` : label); if (!dryRun) fn(); };
    if (decision.action === 'skip') continue;
    if (decision.removeReady) act('remove label ready', () => deps.removeLabel('pr', pr.number, 'ready'));
    if (decision.action === 'fix') {
      if (!pr.labels.includes('claude-fix')) act('add label claude-fix', () => deps.addLabel('pr', pr.number, 'claude-fix'));
    } else if (decision.action === 'update') {
      act('update branch', () => deps.updateBranch(pr.number));
    } else if (decision.action === 'needs-decision') {
      const issueNumber = issueNumberFromBody(pr.body);
      const marker = formatMarker('blocked', { now, run });
      const body = blockedBody({ pr, findings: decision.findings ?? [], reason: decision.reason, marker });
      if (issueNumber === null) {
        act(`comment on PR ${pr.number}`, () => deps.comment('pr', pr.number, body));
      } else {
        const issue = deps.fetchIssue(repo, issueNumber);
        if (!alreadyBlockedForHead(issue, pr.headRefOid.slice(0, 7))) {
          act(`comment on issue ${issueNumber}`, () => deps.comment('issue', issueNumber, body));
          if (!issue.labels.includes('needs-decision')) act('add label needs-decision', () => deps.addLabel('issue', issueNumber, 'needs-decision'));
        }
      }
    } else if (decision.action === 'ready') {
      const changedFiles = deps.changedFiles(repo, pr.number);
      const marker = formatMarker('ready', { now, run });
      const report = readyReport({ pr, config, verdict, changedFiles, marker, runSummary: null });
      act('add label ready', () => deps.addLabel('pr', pr.number, 'ready'));
      act(`comment on PR ${pr.number}`, () => deps.comment('pr', pr.number, report));
      const issueNumber = issueNumberFromBody(pr.body);
      if (issueNumber !== null) act(`comment on issue ${issueNumber}`, () => deps.comment('issue', issueNumber, report));
      actions.push({ pr: pr.number, action: 'ready', reason: null, done });
      break;
    }
    actions.push({ pr: pr.number, action: decision.action, reason: decision.reason ?? null, done });
  }
  return { actions };
}
