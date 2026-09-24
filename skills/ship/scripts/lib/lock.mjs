export const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const PIPELINE_BOTS = new Set(['claude[bot]']);

export function isPipelineComment(c) {
  return Boolean(c.marker) && (TRUSTED.has(c.authorAssociation) || PIPELINE_BOTS.has(c.author));
}

export function lockStatus(issue, { ttlHours, now = new Date() }) {
  const since = issue.comments
    .filter((c) => isPipelineComment(c) && c.marker.kind === 'lock')
    .map((c) => c.createdAt)
    .sort()
    .at(-1) ?? null;
  if (!issue.labels.includes('claude-working')) return { locked: false, stale: false, since };
  const ageMs = since ? new Date(now).getTime() - new Date(since).getTime() : Infinity;
  return { locked: true, stale: ageMs > ttlHours * 3_600_000, since };
}
