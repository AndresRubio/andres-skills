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
// Rows listed in the index for references that are not fetched. Anyone can comment on a public
// repo, so the rest are counted in one closing row instead of listed.
export const MAX_NOT_FETCHED_ROWS = 20;

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

// null when the path has a malformed escape: such a path is never trusted, even undecoded.
function decode(path) {
  try { return decodeURIComponent(path); } catch { return null; }
}

// A decoded permalink path must stay inside the repo and cannot add a query: no empty, "." or
// ".." segment, no "?", "#", "\\" or control character. One pass over the path.
function malformedPath(path) {
  if (/[?#\\\x00-\x1f\x7f]/.test(path)) return true;
  return path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

function trimTrailingPunctuation(raw) {
  let end = raw.length;
  while (end > 0 && '.,;:!?'.includes(raw[end - 1])) end--;
  return raw.slice(0, end);
}

function fields(kind, m, raw) {
  if (kind === 'permalink') {
    const path = decode(m[4]);
    return { kind, owner: m[1], repo: m[2], sha: m[3], path: path ?? m[4], ...(path === null ? { badEscape: true } : {}), start: Number(m[5]), end: Number(m[6] ?? m[5]) };
  }
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
    // The index shows the reference text, so a credential in the URL must not reach it.
    const clean = (x) => `${x.protocol}//${x.host}${x.pathname}${x.search}${x.hash}`;
    const hasCredentials = u.username !== '' || u.password !== '';
    const text = hasCredentials ? clean(u) : undefined;
    if (hasCredentials) { u.username = ''; u.password = ''; }
    const base = { kind: 'url', url: u.href, target: `url:${u.href}`, ...(text ? { text } : {}) };
    if (hasCredentials) return { ...base, reason: 'not fetched: URL includes credentials' };
    const [, o, r] = u.pathname.split('/');
    // u.host is lower case. Only github.com and www.github.com are GitHub; a lookalike such as
    // github.com.evil.example is an ordinary external host and goes through the allow-list.
    if ((u.host === 'github.com' || u.host === 'www.github.com') && o && r && !same(o, r)) return { ...base, ...other };
    if (!Array.isArray(hydrateHosts) || !hydrateHosts.includes(u.host)) return { ...base, reason: 'not fetched: host not in hydrateHosts' };
    return base;
  }
  const foreign = !same(hit.owner, hit.repo);
  const tag = foreign ? `${hit.owner}/${hit.repo}` : '';
  if (hit.kind === 'issue') {
    if (!foreign && hit.number === selfNumber) return null;
    return { kind: 'issue', number: hit.number, target: `issue:${tag}${tag ? '#' : ''}${hit.number}`, ...(foreign ? other : {}) };
  }
  if (hit.kind === 'permalink') {
    const bad = hit.badEscape || malformedPath(hit.path) ? { reason: 'not fetched: malformed path' } : foreign ? other : {};
    return { kind: 'permalink', sha: hit.sha, path: hit.path, start: hit.start, end: hit.end, target: `permalink:${tag}:${hit.sha}:${hit.path}:${hit.start}-${hit.end}`, ...bad };
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
      byTarget.set(ref.target, { reason: null, ...ref, text: ref.text ?? hit.raw, where: s.where, trusted: s.trusted });
    }
  }
  let fetchable = 0;
  const rows = [];
  let listed = 0;
  let omitted = 0;
  // Trusted references first, so a flood of untrusted rows cannot push a trusted reference's
  // "not fetched" reason out of the listed 20 and into the count.
  const ordered = [...byTarget.values()].sort((a, b) => Number(b.trusted) - Number(a.trusted));
  for (const r of ordered) {
    let reason = r.reason;
    if (!reason && !r.trusted) reason = 'not fetched: untrusted author';
    if (!reason && ++fetchable > max) reason = `not fetched: over ${max} references`;
    if (reason && ++listed > MAX_NOT_FETCHED_ROWS) { omitted += 1; continue; }
    rows.push({ n: rows.length + 1, ...r, reason });
  }
  if (omitted) rows.push({ n: rows.length + 1, kind: '-', text: '-', where: '-', trusted: false, omitted, reason: `and ${omitted} more not listed` });
  return rows;
}
