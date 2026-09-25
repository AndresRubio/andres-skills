export function verdictFromComments(comments) {
  const graded = comments.filter((c) => c.marker && ['grade', 'questions', 'split'].includes(c.marker.kind));
  const m = graded.at(-1)?.body.match(/\*\*Verdict:\*\* `([a-z-]+)`/);
  return m ? m[1] : null;
}

export function evaluateFixture(expected, observed) {
  const failures = [];
  const verdicts = [].concat(expected.verdict);
  if (!verdicts.includes(observed.verdict)) failures.push(`verdict ${observed.verdict ?? 'none'} not in [${verdicts.join(', ')}]`);
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
  if (expected.branchPushed === false && observed.branchPushed) failures.push('a claude branch was pushed');
  if (observed.verdict === 'small-gaps' && !observed.commentKinds.includes('assumptions')) {
    failures.push('small-gaps but no assumptions comment');
  }
  return { pass: failures.length === 0, failures };
}
