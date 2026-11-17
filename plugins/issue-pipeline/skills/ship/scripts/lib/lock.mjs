export const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const PIPELINE_BOTS = new Set(['claude[bot]', 'github-actions[bot]']);

export function isPipelineComment(c) {
  return Boolean(c.marker) && (TRUSTED.has(c.authorAssociation) || PIPELINE_BOTS.has(c.author));
}

// An issue is trusted by its author's association, or when a pipeline bot wrote
// it as a sub-issue that its trusted parent's latest split comment names.
export function issueTrusted(issue) {
  if (TRUSTED.has(issue.authorAssociation)) return true;
  return PIPELINE_BOTS.has(issue.author)
    && TRUSTED.has(issue.parent?.authorAssociation)
    && issue.parent.splitInto.includes(issue.number);
}

export function lockStatus(issue, { ttlHours, now = new Date() }) {
  const since = issue.comments
    .filter((c) => isPipelineComment(c) && c.marker.kind === 'lock')
    .map((c) => c.createdAt)
    .sort()
    .at(-1) ?? null;
  if (!issue.labels.includes('pipeline-working')) return { locked: false, stale: false, since };
  const ageMs = since ? new Date(now).getTime() - new Date(since).getTime() : Infinity;
  return { locked: true, stale: ageMs > ttlHours * 3_600_000, since };
}
