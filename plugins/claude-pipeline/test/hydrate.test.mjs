import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, findReferences } from '../skills/ship/scripts/lib/hydrate.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const issue = (body, comments = []) => ({ number: 40, body, comments });
const comment = (id, body, { trusted = true, pipeline = false } = {}) => ({ id, body, trusted, pipeline, marker: pipeline ? { kind: 'report' } : null });
const opts = { repo: 'o/r', hydrateHosts: ['github.com', 'docs.example.com'] };

test('scanText: permalinks, runs, jobs, issue URLs, refs and plain URLs, most specific first', () => {
  const hits = scanText(`See #12, https://github.com/o/r/blob/${SHA}/src/list.ts#L21-L24. Run https://github.com/o/r/actions/runs/987/job/55 and https://github.com/o/r/pull/7/files, then https://docs.example.com/guide.`);
  assert.deepEqual(hits.map((h) => h.kind), ['issue', 'permalink', 'job', 'issue', 'url']);
  assert.equal(hits[4].raw, 'https://docs.example.com/guide');
  assert.deepEqual(scanText('PR#3 and https://github.com/o/r/issues/9#issuecomment-1 and #L10').map((h) => [h.kind, h.raw]), [['issue', 'https://github.com/o/r/issues/9']]);
});

test('scanText: owner/repo#N refs, with the boundary rules of the bare form', () => {
  const hits = scanText('o/r#5 and (x.#3) and /a.o/r#6 and a/b/c#7 and (x.y#4) and &#9 and a#8');
  assert.deepEqual(hits.map((h) => [h.raw, h.owner, h.repo, h.number]), [
    ['o/r#5', 'o', 'r', 5], ['#3', null, null, 3], ['o/r#6', 'o', 'r', 6],
  ]);
});

test('scanText: a malformed percent escape in a permalink path does not throw', () => {
  const [hit] = scanText(`https://github.com/o/r/blob/${SHA}/a%E0%A4%A.ts#L3`);
  assert.equal(hit.kind, 'permalink');
  assert.equal(hit.path, 'a%E0%A4%A.ts');
  const [ref] = findReferences(issue(`https://github.com/o/r/blob/${SHA}/a%E0%A4%A.ts#L3`), opts);
  assert.equal(ref.reason, 'not fetched: malformed path');
});

test('scanText: pathological 200 KB inputs scan in linear time', () => {
  const N = 200_000;
  const inputs = [
    '/'.repeat(N), '#'.repeat(N), '.'.repeat(N), '-'.repeat(N), 'a.'.repeat(N / 2),
    '#1 '.repeat(N / 3), '#1'.repeat(N / 2), 'x#1 '.repeat(N / 4),
    `https://github.com/o/r/blob/${SHA}/`.repeat(Math.floor(N / 76)),
    'https://github.com/o/r/blob/0123456/'.repeat(Math.floor(N / 36)),
    'https://github.com/'.repeat(Math.floor(N / 19)),
    `https://${'.'.repeat(N / 2)}x`, `https://a${'.x'.repeat(N / 4)}`,
    'https://github.com/' + 'a'.repeat(N), 'a/'.repeat(N / 2) + '#1', '1/'.repeat(N / 2),
  ];
  for (const text of inputs) {
    const t0 = performance.now();
    scanText(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${text.slice(0, 24)}... took ${Math.round(ms)} ms`);
  }
});

test('findReferences: in order, this repo only, allow-listed hosts only, the issue itself skipped', () => {
  const refs = findReferences(issue([
    `Follow-up to #12 (not #40). Code: https://github.com/o/r/blob/${SHA}/src/list.ts#L21-L24.`,
    'Failing run: https://github.com/o/r/actions/runs/987654321',
    'Also o/r#5, other/repo#3, https://github.com/other/repo/issues/9, https://docs.example.com/guide and https://elsewhere.dev/x.',
  ].join('\n')), opts);
  assert.deepEqual(refs.map((r) => [r.n, r.kind, r.reason]), [
    [1, 'issue', null], [2, 'permalink', null], [3, 'run', null], [4, 'issue', null],
    [5, 'issue', 'not fetched: other repository'], [6, 'issue', 'not fetched: other repository'],
    [7, 'url', null], [8, 'url', 'not fetched: host not in hydrateHosts'],
  ]);
  assert.deepEqual([refs[0].number, refs[3].number], [12, 5]);
  assert.deepEqual([refs[1].sha, refs[1].path, refs[1].start, refs[1].end], [SHA, 'src/list.ts', 21, 24]);
  assert.equal(refs[2].runId, '987654321');
  assert.equal(refs[0].where, 'body');
});

test('findReferences: duplicates merge; untrusted-only references are listed, not fetched; pipeline comments are ignored', () => {
  const refs = findReferences(issue('See #12 and https://github.com/o/r/issues/12', [
    comment(7, 'look at #77', { trusted: false }),
    comment(8, 'yes, #77 too'),
    comment(9, 'and #88', { trusted: false }),
    comment(10, '**[claude-pipeline]** report · 2026-10-20T10:00:00Z · https://github.com/o/r/actions/runs/555', { pipeline: true }),
  ]), opts);
  assert.deepEqual(refs.map((r) => [r.target, r.where, r.reason]), [
    ['issue:12', 'body', null],
    ['issue:77', 'comment 8', null],
    ['issue:88', 'comment 9', 'not fetched: untrusted author'],
  ]);
});

test('findReferences: at most 20 references are fetched; untrusted ones do not count', () => {
  const body = Array.from({ length: 21 }, (_, i) => `#${i + 1}`).join(' ');
  const refs = findReferences(issue(body, [comment(5, '#99', { trusted: false })]), opts);
  assert.equal(refs.filter((r) => r.reason === null).length, 20);
  assert.equal(refs[20].reason, 'not fetched: over 20 references');
  assert.equal(refs[21].reason, 'not fetched: untrusted author');
});

test('findReferences: a job link folds into a run with a jobId; a null body is fine', () => {
  const [run] = findReferences(issue('https://github.com/o/r/actions/runs/987/job/55'), opts);
  assert.deepEqual([run.kind, run.runId, run.jobId, run.reason], ['run', '987', '55', null]);
  assert.deepEqual(findReferences({ number: 1, body: null, comments: [] }, opts), []);
});

test('findReferences: 200 KB of references stays fast', () => {
  const t0 = performance.now();
  findReferences(issue('#1 '.repeat(66_000)), opts);
  assert.ok(performance.now() - t0 < 2000);
});

test('findReferences: a permalink path that escapes the repo or injects a query is listed, not fetched', () => {
  const link = (path) => `https://github.com/o/r/blob/${SHA}/${path}#L1`;
  const reasons = (path, comments = []) => findReferences(issue(link(path), comments), opts).map((r) => [r.kind, r.reason]);
  const bad = [['permalink', 'not fetched: malformed path']];
  assert.deepEqual(reasons('%2e%2e%2f%2e%2e%2fother%3Fx'), bad);
  assert.deepEqual(reasons('../x'), bad);
  assert.deepEqual(reasons('a/./x'), bad);
  assert.deepEqual(reasons('a//x'), bad);
  assert.deepEqual(reasons('a%3Fref=main'), bad);
  assert.deepEqual(reasons('a%00b'), bad);
  assert.deepEqual(reasons('a%5Cb'), bad);
  assert.deepEqual(reasons('a%23b'), bad);
  assert.deepEqual(reasons('../x', [comment(2, link('../y'), { trusted: false })]).map((r) => r[1]), ['not fetched: malformed path', 'not fetched: malformed path']);
  assert.deepEqual(reasons('%2e%2e%2f%2e%2e%2fother%3Fx%E0'), bad);
  assert.deepEqual(reasons('src/x%E0.ts'), bad);
  assert.deepEqual(reasons('src/app.test.ts'), [['permalink', null]]);
  assert.deepEqual(reasons('.github/workflows/ci.yml'), [['permalink', null]]);
});

test('findReferences: thousands of untrusted URLs list 20 rows and one count, never thousands', () => {
  const comments = Array.from({ length: 10 }, (_, c) => comment(c + 1, Array.from({ length: 500 }, (_, i) => `https://docs.example.com/p${c}-${i}`).join(' '), { trusted: false }));
  const refs = findReferences(issue('Context: #12', comments), opts);
  const listed = refs.filter((r) => r.reason !== null);
  assert.equal(listed.length, 21);
  assert.equal(refs.filter((r) => r.reason === null).length, 1);
  assert.equal(listed.filter((r) => r.reason === 'not fetched: untrusted author').length, 20);
  assert.equal(listed.at(-1).reason, 'and 4980 more not listed');
  assert.equal(listed.at(-1).omitted, 4980);
  assert.deepEqual(refs.map((r) => r.n), refs.map((_, i) => i + 1));
  // A trusted reference with its own not-fetched reason is listed even when earlier untrusted comments
  // would fill all 20 rows on their own.
  const flooded = findReferences(issue('Context: #12', [...comments, comment(99, 'see https://wiki.example/trusted-page', { trusted: true })]), opts);
  const trustedRow = flooded.find((r) => r.target === 'https://wiki.example/trusted-page' || r.text === 'https://wiki.example/trusted-page');
  assert.ok(trustedRow, 'the trusted reference has a row of its own');
  assert.equal(trustedRow.reason, 'not fetched: host not in hydrateHosts');
  assert.equal(flooded.filter((r) => r.reason !== null).length, 21);
  // Other not-fetched reasons share the same cap.
  const hosts = Array.from({ length: 300 }, (_, i) => `https://h${i}.example/x`).join(' ');
  const r2 = findReferences(issue(hosts), opts);
  assert.equal(r2.length, 21);
  assert.equal(r2.at(-1).reason, 'and 280 more not listed');
});

test('findReferences: lookalike and upper-case GitHub hosts are told apart by the allow-list', () => {
  const host = ['github.com', 'docs.example.com'];
  const reasons = (text, hydrateHosts = host) => findReferences(issue(text), { repo: 'o/r', hydrateHosts }).map((r) => r.reason);
  assert.deepEqual(reasons('https://github.com.evil.example/o/r/readme'), ['not fetched: host not in hydrateHosts']);
  assert.deepEqual(reasons('https://github.com.evil.example/other/repo'), ['not fetched: host not in hydrateHosts']);
  assert.deepEqual(reasons('https://notgithub.com/other/repo'), ['not fetched: host not in hydrateHosts']);
  assert.deepEqual(reasons('https://GITHUB.COM/other/repo/tree/main'), ['not fetched: other repository']);
  assert.deepEqual(reasons('https://www.github.com/other/repo/tree/main'), ['not fetched: other repository']);
  assert.deepEqual(reasons('https://www.github.com/o/r/tree/main'), ['not fetched: host not in hydrateHosts']);
  assert.deepEqual(reasons('https://github.com:8443/other/repo'), ['not fetched: host not in hydrateHosts']);
  assert.deepEqual(reasons('https://github.com/o/r/tree/main'), [null]);
  assert.deepEqual(reasons('https://github.com/o/r/tree/main', null), ['not fetched: host not in hydrateHosts']);
});

test('findReferences: a URL with userinfo is not fetched and its credential is not kept', () => {
  const refs = findReferences(issue('see https://admin:hunter2@docs.example.com/secret?x=1#top and https://tok@docs.example.com/y'), opts);
  assert.equal(refs.length, 2);
  for (const r of refs) {
    assert.equal(r.reason, 'not fetched: URL includes credentials');
    assert.doesNotMatch(JSON.stringify(r), /hunter2|admin|tok@/);
  }
  assert.equal(refs[0].text, 'https://docs.example.com/secret?x=1#top');
});
