import { ghJson, ghText, fetchPr, fetchPrComments, fetchIssue, postPrComment, postIssueComment } from './github.mjs';
import { latestVerdict } from './verdict.mjs';
import { decideReady, readyReport, issueNumberFromBody } from './ready.mjs';
import { formatMarker, defaultRun } from './marker.mjs';
import { lockStatus } from './lock.mjs';

const LOCK_GATED = new Set(['fix', 'update', 'needs-decision']);

export function realDeps(repo) {
  return {
    listPrs: () => ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,headRefName,isCrossRepository,isDraft']),
    fetchPr: (r, n) => fetchPr(r, n),
    fetchPrComments: (r, n) => fetchPrComments(r, n),
    fetchIssue: (r, n) => fetchIssue(r, n),
    // BEHIND in mergeStateStatus may only be reported when branch protection requires up-to-date
    // branches, so "behind" is read from the compare API. Verify on the first sandbox run.
    compare: (r, base, head) => ghJson(['api', `repos/${r}/compare/${base}...${head}`, '--jq', '{behind_by}']),
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

export function alreadyMarkedForHead(comments, kind, sha7) {
  return comments.some((c) => c.pipeline && c.marker?.kind === kind && c.body.includes(`head \`${sha7}\``));
}

export async function runReady({ repo, config, now = new Date(), dryRun = false, run = defaultRun() }, deps = realDeps(repo)) {
  if (config.enabled === false) return { actions: [], disabled: true };
  const prs = deps.listPrs()
    .filter((p) => !p.isDraft && !p.isCrossRepository && p.headRefName.startsWith('claude/'))
    .sort((a, b) => a.number - b.number);
  const actions = [];
  for (const listed of prs) {
    const done = [];
    const act = (label, fn) => { done.push(dryRun ? `would ${label}` : label); if (!dryRun) fn(); };
    try {
      const pr = deps.fetchPr(repo, listed.number);
      const prComments = deps.fetchPrComments(repo, pr.number);
      const sha7 = pr.headRefOid.slice(0, 7);
      const verdict = latestVerdict(prComments, pr.headRefOid);
      let decision = decideReady({ pr, config, verdict });
      if (decision.action === 'skip') continue;
      // A PR is ready only when it holds every commit of its base (verify on the first sandbox run).
      if (decision.action === 'ready' || decision.action === 'already-ready') {
        const { behind_by: behindBy } = deps.compare(repo, pr.baseRefName, pr.headRefOid);
        if (behindBy > 0) decision = { action: 'update', reason: 'behind base', ...(pr.labels.includes('ready') ? { removeReady: true } : {}) };
      }
      const issueNumber = issueNumberFromBody(pr.body);
      let issue;
      const linkedIssue = () => (issue ??= deps.fetchIssue(repo, issueNumber));
      // A run holding the issue's lock (a fix run, or the ship run still reporting) owns the branch:
      // asking for another fix, updating the branch or posting a decision now would race it. A lock
      // older than lockTtlHours is stale and no longer holds anything back. No write at all here.
      if (LOCK_GATED.has(decision.action) && issueNumber !== null) {
        const lock = lockStatus(linkedIssue(), { ttlHours: config.lockTtlHours, now });
        if (lock.locked && !lock.stale) {
          actions.push({ pr: pr.number, action: 'wait', reason: `fix run in progress (claude-working on issue ${issueNumber})`, done });
          continue;
        }
      }
      if (decision.removeReady) act('remove label ready', () => deps.removeLabel('pr', pr.number, 'ready'));
      if (decision.action === 'fix') {
        if (!pr.labels.includes('claude-fix')) act('add label claude-fix', () => deps.addLabel('pr', pr.number, 'claude-fix'));
      } else if (decision.action === 'update') {
        act('update branch', () => deps.updateBranch(pr.number));
      } else if (decision.action === 'needs-decision') {
        const marker = formatMarker('blocked', { now, run });
        const body = blockedBody({ pr, findings: decision.findings ?? [], reason: decision.reason, marker });
        if (issueNumber === null) {
          if (!alreadyMarkedForHead(prComments, 'blocked', sha7)) act(`comment on PR ${pr.number}`, () => deps.comment('pr', pr.number, body));
        } else {
          const issue = linkedIssue();
          if (!alreadyMarkedForHead(issue.comments, 'blocked', sha7)) act(`comment on issue ${issueNumber}`, () => deps.comment('issue', issueNumber, body));
          if (!issue.labels.includes('needs-decision')) act('add label needs-decision', () => deps.addLabel('issue', issueNumber, 'needs-decision'));
        }
      } else if (decision.action === 'ready') {
        const changedFiles = deps.changedFiles(repo, pr.number);
        const marker = formatMarker('ready', { now, run });
        const report = readyReport({ pr, config, verdict, changedFiles, marker, runSummary: null });
        if (!alreadyMarkedForHead(prComments, 'ready', sha7)) act(`comment on PR ${pr.number}`, () => deps.comment('pr', pr.number, report));
        if (issueNumber !== null) act(`comment on issue ${issueNumber}`, () => deps.comment('issue', issueNumber, report));
        act('add label ready', () => deps.addLabel('pr', pr.number, 'ready'));
        actions.push({ pr: pr.number, action: 'ready', reason: null, done });
        break;
      }
      actions.push({ pr: pr.number, action: decision.action, reason: decision.reason ?? null, done });
    } catch (err) {
      actions.push({ pr: listed.number, action: 'error', reason: err.message, done });
    }
  }
  return { actions };
}
