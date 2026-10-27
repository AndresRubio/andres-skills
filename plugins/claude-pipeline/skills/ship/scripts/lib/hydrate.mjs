// Context pre-hydration (spec §5.6, D20; bounds from amendment E): which references in the trusted
// issue text to fetch. Pure: hydrate-run.mjs does the fetching.
//
// Every scan here is linear in the text. The GitHub patterns start at a fixed literal and every
// character class stops at "/", so a failed attempt never re-reads a long run. The path of a
// permalink is the one open-ended part: it is capped at MAX_PATH so thousands of
// ".../blob/<sha>/" prefixes inside one unbroken run cannot each rescan the rest of it.
// Bare "#N" references are found from the "#" and checked backwards by hand (see scanRefs),
// because a regex with an optional "owner/repo" prefix would rescan each "a.a.a." run.
export const MAX_REFERENCES = 20;

const MAX_PATH = 4096;
const OR = '([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)';
const GH = `https://github\\.com/${OR}`;
const PATTERNS = [
  ['permalink', new RegExp(`${GH}/blob/([0-9a-f]{7,40})/([^\\s#?)\\]>"'\`]{1,${MAX_PATH}})#L(\\d+)(?:-L(\\d+))?`, 'g')],
  ['job', new RegExp(`${GH}/actions/runs/(\\d+)/job/(\\d+)`, 'g')],
  ['run', new RegExp(`${GH}/actions/runs/(\\d+)`, 'g')],
  ['issue', new RegExp(`${GH}/(?:issues|pull)/(\\d+)`, 'g')],
  ['url', /https:\/\/[^\s<>()[\]"'`]+/g],
];

const isNameChar = (c) => c !== undefined && /[A-Za-z0-9_.-]/.test(c);
const isWordChar = (c) => c !== undefined && /\w/.test(c);

function decode(path) {
  try { return decodeURIComponent(path); } catch { return path; }
}

function trimTrailingPunctuation(raw) {
  let end = raw.length;
  while (end > 0 && '.,;:!?'.includes(raw[end - 1])) end--;
  return raw.slice(0, end);
}

function fields(kind, m, raw) {
  if (kind === 'permalink') return { kind, owner: m[1], repo: m[2], sha: m[3], path: decode(m[4]), start: Number(m[5]), end: Number(m[6] ?? m[5]) };
  if (kind === 'job') return { kind, owner: m[1], repo: m[2], runId: m[3], jobId: m[4] };
  if (kind === 'run') return { kind, owner: m[1], repo: m[2], runId: m[3], jobId: null };
  if (kind === 'issue') return { kind, owner: m[1], repo: m[2], number: Number(m[3]) };
  return { kind: 'url', url: raw };
}

// "#N", "#N" after "owner/repo", never inside a word, a path, an entity or "##".
// Same matches as /(?<![\w/#&])(?:OWNER\/REPO)?#(\d+)\b/g, found from each "#" backwards.
function scanRefs(text, overlaps) {
  const hits = [];
  for (const m of text.matchAll(/#(\d+)\b/g)) {
    const h = m.index;
    const end = h + m[0].length;
    let start = h;
    let owner = null;
    let repo = null;
    let r = h;
    while (r > 0 && isNameChar(text[r - 1])) r--;
    if (r < h && text[r - 1] === '/') {
      let os = r - 1;
      while (os > 0 && isNameChar(text[os - 1])) os--;
      // The leftmost start that may begin a match: the run's first character unless "/", "#" or
      // "&" precedes it, otherwise the first character after a "." or "-" inside the run.
      for (let s = os; s < r - 1; s++) {
        const prev = text[s - 1];
        if (s === os ? (prev === undefined || !'/#&'.includes(prev)) : !isWordChar(prev)) {
          start = s;
          owner = text.slice(s, r - 1);
          repo = text.slice(r, h);
          break;
        }
      }
    }
    if (owner === null) {
      const prev = text[h - 1];
      if (prev !== undefined && (isWordChar(prev) || prev === '/' || prev === '#' || prev === '&')) continue;
    }
    if (overlaps(start, end)) continue;
    hits.push({ start, end, hit: { index: start, raw: text.slice(start, end), kind: 'issue', owner, repo, number: Number(m[1]) } });
  }
  return hits;
}

export function scanText(text) {
  text = String(text ?? '');
  const taken = new Uint8Array(text.length);
  const overlaps = (s, e) => { for (let i = s; i < e; i++) if (taken[i]) return true; return false; };
  const claim = (s, e) => taken.fill(1, s, e);
  const hits = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = kind === 'url' ? trimTrailingPunctuation(m[0]) : m[0];
      const start = m.index;
      const end = start + raw.length;
      if (overlaps(start, end)) continue;
      claim(start, end);
      hits.push({ index: start, raw, ...fields(kind, m, raw) });
    }
  }
  for (const { start, end, hit } of scanRefs(text, overlaps)) {
    claim(start, end);
    hits.push(hit);
  }
  return hits.sort((a, b) => a.index - b.index);
}

function classify(hit, { owner, name, selfNumber, hydrateHosts }) {
  const same = (o, r) => !o || (o.toLowerCase() === owner.toLowerCase() && r.toLowerCase() === name.toLowerCase());
  const other = { reason: 'not fetched: other repository' };
  if (hit.kind === 'url') {
    let u;
    try { u = new URL(hit.url); } catch { return null; }
    const base = { kind: 'url', url: u.href, target: `url:${u.href}` };
    const [, o, r] = u.pathname.split('/');
    if (u.host === 'github.com' && o && r && !same(o, r)) return { ...base, ...other };
    if (!hydrateHosts.includes(u.host)) return { ...base, reason: 'not fetched: host not in hydrateHosts' };
    return base;
  }
  const foreign = !same(hit.owner, hit.repo);
  const tag = foreign ? `${hit.owner}/${hit.repo}` : '';
  if (hit.kind === 'issue') {
    if (!foreign && hit.number === selfNumber) return null;
    return { kind: 'issue', number: hit.number, target: `issue:${tag}${tag ? '#' : ''}${hit.number}`, ...(foreign ? other : {}) };
  }
  if (hit.kind === 'permalink') {
    return { kind: 'permalink', sha: hit.sha, path: hit.path, start: hit.start, end: hit.end, target: `permalink:${tag}:${hit.sha}:${hit.path}:${hit.start}-${hit.end}`, ...(foreign ? other : {}) };
  }
  return { kind: 'run', runId: hit.runId, jobId: hit.jobId, target: `run:${tag}:${hit.runId}:${hit.jobId ?? ''}`, ...(foreign ? other : {}) };
}

export function findReferences(issue, { repo, hydrateHosts, max = MAX_REFERENCES }) {
  const [owner, name] = repo.split('/');
  // Pipeline comments are skipped: every marker line links its own Actions run.
  const sources = [
    { where: 'body', text: issue.body, trusted: true },
    ...[...issue.comments].sort((a, b) => a.id - b.id).filter((c) => !c.pipeline).map((c) => ({ where: `comment ${c.id}`, text: c.body, trusted: c.trusted === true })),
  ];
  const byTarget = new Map();
  for (const s of sources) {
    for (const hit of scanText(s.text)) {
      const ref = classify(hit, { owner, name, selfNumber: issue.number, hydrateHosts });
      if (!ref) continue;
      const prior = byTarget.get(ref.target);
      if (prior) {
        if (s.trusted && !prior.trusted) Object.assign(prior, { trusted: true, where: s.where });
        continue;
      }
      byTarget.set(ref.target, { reason: null, ...ref, text: hit.raw, where: s.where, trusted: s.trusted });
    }
  }
  let fetchable = 0;
  return [...byTarget.values()].map((r, i) => {
    let reason = r.reason;
    if (!reason && !r.trusted) reason = 'not fetched: untrusted author';
    if (!reason && ++fetchable > max) reason = `not fetched: over ${max} references`;
    return { n: i + 1, ...r, reason };
  });
}
