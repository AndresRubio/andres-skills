export const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function lockStatus(issue, { ttlHours, now = new Date() }) {
  const since = issue.comments
    .filter((c) => c.marker?.kind === 'lock' && TRUSTED.has(c.authorAssociation))
    .map((c) => c.createdAt)
    .sort()
    .at(-1) ?? null;
  if (!issue.labels.includes('claude-working')) return { locked: false, stale: false, since };
  const ageMs = since ? new Date(now).getTime() - new Date(since).getTime() : Infinity;
  return { locked: true, stale: ageMs > ttlHours * 3_600_000, since };
}
