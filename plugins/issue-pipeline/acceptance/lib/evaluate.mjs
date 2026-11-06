const VERDICT_LINE = /\*\*Verdict:\*\* `([a-z-]+)`/;

// A back-off `deferred` has no Verdict line, so it doesn't hide the grade before it.
export function verdictFromComments(comments) {
  const graded = comments.filter((c) => c.marker && ['grade', 'questions', 'split', 'deferred'].includes(c.marker.kind) && VERDICT_LINE.test(c.body));
  return graded.at(-1)?.body.match(VERDICT_LINE)[1] ?? null;
}

// texts: [{ where, text }]. Returns the `where` of every text that contains `forbidden`.
// An empty forbidden string would match everything, so it is refused rather than
// treated as "no leaks".
export function findLeaks(texts, forbidden) {
  if (typeof forbidden !== 'string' || forbidden.length === 0) throw new Error('findLeaks needs a non-empty forbidden text');
  return texts.filter((t) => (t.text ?? '').includes(forbidden)).map((t) => t.where);
}

// Rows of research.md's `## Context` table whose result cell starts with "fetched" (test issue 15).
export function countFetched(researchMd) {
  const text = String(researchMd ?? '');
  const start = text.search(/^## Context\b/m);
  if (start < 0) return 0;
  const rest = text.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => /^\|\s*\d+\s*\|/.test(l) && /\|\s*fetched\b/.test(l)).length;
}

export function evaluateFixture(expected, observed) {
  const failures = [];
  const verdicts = [].concat(expected.verdict);
  if (!expected.seededPr && !verdicts.includes(observed.verdict)) failures.push(`verdict ${observed.verdict ?? 'none'} not in [${verdicts.join(', ')}]`);
  if (expected.pr === true && !observed.pr) failures.push('expected a PR, found none');
  if (expected.pr === false && observed.pr) failures.push(`expected no PR, found ${observed.pr.url}`);
  if (expected.prFixesIssue && observed.pr && !observed.pr.body.includes(`Fixes #${observed.issueNumber}`)) {
    failures.push(`PR body lacks "Fixes #${observed.issueNumber}"`);
  }
  for (const l of expected.labelsPresent ?? []) if (!observed.labels.includes(l)) failures.push(`label ${l} missing`);
  for (const l of expected.labelsAbsent ?? []) if (observed.labels.includes(l)) failures.push(`label ${l} should be absent`);
  for (const k of expected.commentKinds ?? []) if (!observed.commentKinds.includes(k)) failures.push(`no ${k} comment`);
  for (const a of expected.artifacts ?? []) if (!observed.artifacts.includes(a)) failures.push(`artifact ${a} missing`);
  if (expected.screenshots && observed.screenshots === 0) failures.push('no screenshots');
  if (expected.minSubIssues !== undefined && observed.subIssues < expected.minSubIssues) {
    failures.push(`${observed.subIssues} sub-issues < ${expected.minSubIssues}`);
  }
  if (expected.branchPushed === false && observed.branchPushed) failures.push('a pipeline branch was pushed');
  if (expected.noLeak) {
    // Fail closed: a missing scan result must not read as "no leaks".
    if (!Array.isArray(observed.leaks)) failures.push('private-data scan did not run');
    else for (const where of observed.leaks) failures.push(`private marker found in ${where}`);
  }
  for (const l of expected.prLabelsPresent ?? []) if (!(observed.prLabels ?? []).includes(l)) failures.push(`PR label ${l} missing`);
  for (const l of expected.prLabelsAbsent ?? []) if ((observed.prLabels ?? []).includes(l)) failures.push(`PR label ${l} should be absent`);
  for (const k of expected.prCommentKinds ?? []) if (!(observed.prCommentKinds ?? []).includes(k)) failures.push(`no ${k} comment on the PR`);
  if (expected.reviewVerdict !== undefined && observed.reviewVerdict !== expected.reviewVerdict) {
    failures.push(`review verdict ${observed.reviewVerdict ?? 'none'}, expected ${expected.reviewVerdict}`);
  }
  if (expected.fixRuns !== undefined && observed.fixRuns !== expected.fixRuns) failures.push(`${observed.fixRuns ?? 0} fix runs, expected ${expected.fixRuns}`);
  if (expected.readyReportMentions !== undefined && !(observed.readyReport ?? '').includes(expected.readyReportMentions)) {
    failures.push(`ready report does not mention "${expected.readyReportMentions}"`);
  }
  if (observed.verdict === 'small-gaps' && !observed.commentKinds.includes('assumptions')) {
    failures.push('small-gaps but no assumptions comment');
  }
  if (expected.contextFetched !== undefined && observed.contextFetched !== expected.contextFetched) {
    failures.push(`${observed.contextFetched ?? 0} references fetched, expected ${expected.contextFetched}`);
  }
  failures.push(...evaluateWait(expected, observed));
  return { pass: failures.length === 0, failures };
}

const WAIT_LINE = /^Waiting for: (.+)$/;

// The newest pipeline `deferred` on an issue and what followed it. A back-off (maxParallel) has no
// Waiting for line. `humanBetween` counts trusted unmarked comments before the next lock: a restart
// that needed the owner did not happen "without you" (spec §10, test issues 9 and 11).
export function waitTimeline(comments) {
  const ordered = [...comments].sort((a, b) => a.id - b.id);
  const deferred = ordered.filter((c) => c.pipeline && c.marker?.kind === 'deferred').at(-1);
  if (!deferred) return { deferred: false, waitKeys: [], relocked: false, humanBetween: 0 };
  const last = deferred.body.trim().split(/\r?\n/).at(-1).trim();
  const m = last.match(WAIT_LINE);
  const after = ordered.filter((c) => c.id > deferred.id);
  const relock = after.find((c) => c.pipeline && c.marker?.kind === 'lock');
  const humanBetween = after.filter((c) => !c.marker && c.trusted && (!relock || c.id < relock.id)).length;
  return { deferred: true, waitKeys: m ? m[1].split(',').map((k) => k.trim()) : [], relocked: Boolean(relock), humanBetween };
}

export function evaluateWait(expected, observed) {
  if (!expected.waitsFor) return [];
  const key = String(observed.waitsForIssue);
  const w = observed.wait;
  if (w.deferred && w.waitKeys.includes(key)) {
    const failures = [];
    if (!w.relocked) failures.push(`deferred for #${key} but never started again`);
    if (w.humanBetween > 0) failures.push(`started again only after ${w.humanBetween} owner comment(s)`);
    return failures;
  }
  if (expected.orConflictFix && !w.deferred && (observed.fixRuns ?? 0) >= 1) return [];
  return [`did not wait for #${key}${expected.orConflictFix ? ' and took no conflict fix run' : ''}`];
}

export function evaluateGroup(expected, members) {
  const failures = [];
  for (const m of members) for (const f of evaluateFixture(expected.member, m.observed).failures) failures.push(`${m.fixture}: ${f}`);
  const backedOff = members.filter((m) => m.observed.wait.deferred && m.observed.wait.waitKeys.length === 0);
  if (backedOff.length !== expected.deferredMembers) failures.push(`${backedOff.length} members backed off, expected ${expected.deferredMembers}`);
  for (const m of backedOff) {
    if (!m.observed.wait.relocked) failures.push(`${m.fixture}: backed off and never started again`);
    if (m.observed.wait.humanBetween > 0) failures.push(`${m.fixture}: started again only after an owner comment`);
  }
  return { pass: failures.length === 0, failures };
}
