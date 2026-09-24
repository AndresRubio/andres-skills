export function lockStatus(issue, { ttlHours, now = new Date() }) {
  const since = issue.comments
    .filter((c) => c.marker && c.marker.kind === 'lock')
    .map((c) => c.marker.at)
    .sort()
    .at(-1) ?? null;
  if (!issue.labels.includes('claude-working')) return { locked: false, stale: false, since };
  const ageMs = since ? new Date(now).getTime() - new Date(since).getTime() : Infinity;
  return { locked: true, stale: ageMs > ttlHours * 3_600_000, since };
}
