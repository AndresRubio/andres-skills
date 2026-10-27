import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { hydrate, fetchLimited, realHydrateDeps } from '../skills/ship/scripts/lib/hydrate-run.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { tempDir } from './helpers/git.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const config = { hydrateHosts: ['github.com', 'docs.example.com'] };
const issue = (body, comments = []) => ({ number: 40, url: 'https://github.com/o/r/issues/40', body, comments });
const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

function fakeDeps(json = {}, text = {}, url = {}) {
  const pick = (table, args) => {
    const key = args.join(' ');
    if (!(key in table)) throw new Error(`no route for ${key}`);
    if (table[key] instanceof Error) throw table[key];
    return table[key];
  };
  return {
    ghJson: (args) => pick(json, args),
    ghText: (args) => pick(text, args),
    fetchUrl: async (u) => url[u] ?? { body: Buffer.from('doc text'), contentType: 'text/plain', finalUrl: u, isPdf: false, overLimit: false },
    pdfToText: (buf) => `pdf text of ${buf.length} bytes`,
  };
}

test('hydrate fetches an issue, a permalink with 20 lines of context and a failing run, and indexes them', async () => {
  const out = tempDir('ctx-');
  const deps = fakeDeps({
    'api repos/o/r/issues/12': { number: 12, title: 'Wrong month', state: 'closed', labels: [{ name: 'bug' }], body: 'The month is off by one.' },
    'run view 987 --repo o/r --json name,conclusion,jobs': { name: 'CI', conclusion: 'failure', jobs: [{ databaseId: 55, name: 'test', conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'npm test', conclusion: 'failure' }] }] },
  }, {
    [`api -H Accept: application/vnd.github.raw repos/o/r/contents/src/list.ts?ref=${SHA}`]: lines(50),
    'run view --job 55 --repo o/r --log-failed': lines(250, 'log'),
  });
  const body = `Follow-up to #12. Code: https://github.com/o/r/blob/${SHA}/src/list.ts#L21-L24. Run: https://github.com/o/r/actions/runs/987`;
  const r = await hydrate({ issue: issue(body), repo: 'o/r', config, outDir: out }, deps);
  assert.deepEqual([r.fetched, r.notFetched], [3, 0]);
  assert.deepEqual(readdirSync(out).sort(), ['01-issue-12.md', '02-permalink-list.ts-21-24.md', '03-run-987.md', 'index.md']);
  const permalink = readFileSync(path.join(out, '02-permalink-list.ts-21-24.md'), 'utf8');
  assert.match(permalink, /^ {4}1 {2}line 1$/m);
  assert.match(permalink, /^ {3}44 {2}line 44$/m);
  assert.doesNotMatch(permalink, /line 45/);
  const run = readFileSync(path.join(out, '03-run-987.md'), 'utf8');
  assert.match(run, /Failing step: npm test\./);
  assert.match(run, /^log 51$/m);
  assert.doesNotMatch(run, /^log 50$/m);
  const index = readFileSync(path.join(out, 'index.md'), 'utf8');
  assert.match(index, /^\| 1 \| `#12` \| issue \| body \| fetched: `01-issue-12\.md`, \d+ lines, [\d.]+ KB \|$/m);
  assert.match(index, /untrusted/);
});

test('bounds: over 64 KB and over the 256 KB budget are listed, not fetched', async () => {
  const out = tempDir('ctx-');
  const big = (n, kb) => ({ number: n, title: `t${n}`, state: 'open', labels: [], body: 'x'.repeat(kb * 1024) });
  const deps = fakeDeps({
    'api repos/o/r/issues/1': big(1, 60), 'api repos/o/r/issues/2': big(2, 60), 'api repos/o/r/issues/3': big(3, 70),
    'api repos/o/r/issues/4': big(4, 60), 'api repos/o/r/issues/5': big(5, 60), 'api repos/o/r/issues/6': big(6, 60),
  });
  const r = await hydrate({ issue: issue('#1 #2 #3 #4 #5 #6'), repo: 'o/r', config, outDir: out }, deps);
  const index = readFileSync(path.join(out, 'index.md'), 'utf8');
  assert.match(index, /^\| 3 \| `#3` \| issue \| body \| not fetched: over 64 KB \|$/m);
  assert.match(index, /^\| 6 \| `#6` \| issue \| body \| not fetched: budget \|$/m);
  assert.equal(r.fetched, 4);
  assert.ok(r.bytes <= 256 * 1024);
});

test('a failed fetch is a line in the index, never a stop; PDFs go through pdftotext; a redirect off the allow-list is refused', async () => {
  const out = tempDir('ctx-');
  const deps = fakeDeps({ 'api repos/o/r/issues/12': new Error('HTTP 404: Not Found (https://api.github.com/repos/o/r/issues/12)\nmore') }, {}, {
    'https://docs.example.com/spec.pdf': { body: Buffer.from('%PDF-1.7 bytes'), contentType: 'application/pdf', finalUrl: 'https://docs.example.com/spec.pdf', isPdf: true, overLimit: false },
    'https://docs.example.com/moved': { body: Buffer.from('x'), contentType: 'text/html', finalUrl: 'https://evil.example/x', isPdf: false, overLimit: false },
  });
  const r = await hydrate({ issue: issue('#12, https://docs.example.com/spec.pdf and https://docs.example.com/moved') , repo: 'o/r', config, outDir: out }, deps);
  const index = readFileSync(path.join(out, 'index.md'), 'utf8');
  assert.match(index, /\| not fetched: HTTP 404: Not Found \(https:\/\/api\.github\.com\/repos\/o\/r\/issues\/12\) \|/);
  assert.match(index, /\| 2 \| `https:\/\/docs\.example\.com\/spec\.pdf` \| url \| body \| fetched: /);
  assert.match(index, /not fetched: redirected off allowed hosts/);
  assert.equal(r.fetched, 1);
  assert.match(readFileSync(path.join(out, '01-url-docs.example.com.md'), 'utf8'), /pdf text of 14 bytes/);
});

test('fetchLimited reads at most 64 KB plus one byte, times out, and reports the final URL', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/text') { res.setHeader('content-type', 'text/plain'); res.end('hello'); return; }
    if (req.url === '/big') { res.setHeader('content-type', 'text/plain'); res.end('x'.repeat(70 * 1024)); return; }
    if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', '/text?moved=1'); res.end(); return; }
    if (req.url === '/slow') { setTimeout(() => res.end('late'), 2000); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetchLimited(`${base}/text`);
    assert.deepEqual([ok.body.toString(), ok.overLimit, ok.isPdf], ['hello', false, false]);
    const big = await fetchLimited(`${base}/big`);
    assert.equal(big.overLimit, true);
    assert.ok(big.body.length <= 64 * 1024 + 1);
    assert.match((await fetchLimited(`${base}/redirect`)).finalUrl, /\/text\?moved=1$/);
    await assert.rejects(fetchLimited(`${base}/slow`, { timeoutMs: 100 }));
    await assert.rejects(fetchLimited(`${base}/missing`), /HTTP 404/);
  } finally {
    server.close();
  }
});

const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('pdfToText runs pdftotext -layout on a real PDF', { skip: !hasPdftotext && 'pdftotext is not installed' }, async () => {
  const { pdfToText } = await import('../skills/ship/scripts/lib/hydrate-run.mjs');
  const pdf = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 40 Td (Hydrated text) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  assert.match(pdfToText(Buffer.from(pdf)), /Hydrated text/);
});

test('CLI hydrate takes the repo from the issue URL and writes the index', () => {
  const dir = tempDir('cli-');
  writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(issue('See #12')));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const bin = fakeGh({ 'api repos/o/r/issues/12': { number: 12, title: 'Wrong month', state: 'open', labels: [], body: 'b' } });
  const r = runCli(['hydrate', '--issue-file', path.join(dir, 'issue.json'), '--config-file', path.join(dir, 'config.json'), '--out', path.join(dir, 'context')], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().fetched, 1);
  assert.ok(existsSync(path.join(dir, 'context', 'index.md')));
});

test('every path segment and the ref are encoded in the gh api argument', async () => {
  const out = tempDir('ctx-');
  const route = `api -H Accept: application/vnd.github.raw repos/o/r/contents/docs/my%20file%2520.md?ref=${SHA}`;
  const seen = [];
  const deps = fakeDeps({}, { [route]: lines(5) });
  const ghText = deps.ghText;
  deps.ghText = (args) => { seen.push(args[args.length - 1]); return ghText(args); };
  const body = `See https://github.com/o/r/blob/${SHA}/docs/my%20file%2520.md#L2-L3`;
  const r = await hydrate({ issue: issue(body), repo: 'o/r', config, outDir: out }, deps);
  assert.equal(r.fetched, 1);
  assert.deepEqual(seen, [`repos/o/r/contents/docs/my%20file%2520.md?ref=${SHA}`]);
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, host: `127.0.0.1:${server.address().port}` };
}

test('a real redirect to a host outside hydrateHosts is refused and nothing is written; one inside is kept', async () => {
  let targetHits = 0;
  const target = await listen((req, res) => { targetHits += 1; res.setHeader('content-type', 'text/plain'); res.end('elsewhere'); });
  const start = await listen((req, res) => {
    if (req.url === '/moved') { res.statusCode = 302; res.setHeader('location', `http://${target.host}/x`); res.end(); return; }
    res.setHeader('content-type', 'text/plain'); res.end('here');
  });
  try {
    const out = tempDir('ctx-');
    const map = { 'https://docs.example.com/moved': `http://${start.host}/moved`, 'https://docs.example.com/stay': `http://${start.host}/stay` };
    const deps = { ...fakeDeps(), fetchUrl: (u, o) => fetchLimited(map[u], o) };
    const r = await hydrate({ issue: issue('https://docs.example.com/moved https://docs.example.com/stay'), repo: 'o/r', config: { hydrateHosts: ['docs.example.com', start.host] }, outDir: out }, deps);
    assert.match(readFileSync(path.join(out, 'index.md'), 'utf8'), /\| not fetched: redirected off allowed hosts \|/);
    assert.deepEqual(readdirSync(out).sort(), ['01-url-docs.example.com.md', 'index.md']);
    assert.equal(r.fetched, 1);
    assert.equal(targetHits, 0, 'the off-list server never received a request');
  } finally {
    start.server.close();
    target.server.close();
  }
});

test('a permalink with a very long file name is fetched under a bounded file name and never rejects', async () => {
  const out = tempDir('ctx-');
  const name = `${'a'.repeat(300)}.md`;
  const route = `api -H Accept: application/vnd.github.raw repos/o/r/contents/${name}?ref=${SHA}`;
  const deps = fakeDeps({}, { [route]: lines(3) });
  const r = await hydrate({ issue: issue(`https://github.com/o/r/blob/${SHA}/${name}#L1`), repo: 'o/r', config, outDir: out }, deps);
  assert.equal(r.fetched, 1);
  assert.ok(readdirSync(out).every((f) => f.length <= 120));
});

test('real gh deps report the first stderr line of a failed call, not the command line', () => {
  const bin = fakeGh({ 'api repos/o/r/issues/9': { __ghError: 'HTTP 404: Not Found (https://api.github.com/repos/o/r/issues/9)\nextra' } });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const deps = realHydrateDeps();
    assert.throws(() => deps.ghJson(['api', 'repos/o/r/issues/9']), (err) => err.message === 'HTTP 404: Not Found (https://api.github.com/repos/o/r/issues/9)');
    assert.throws(() => deps.ghText(['api', 'repos/o/r/issues/9']), /^Error: HTTP 404: Not Found/);
  } finally {
    process.env.PATH = saved;
  }
});

// A fetch stand-in: `to(url, calls)` gives the Location of a 302, or null for a 200 text page.
function stubFetch(to) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const loc = to(url, calls);
    return loc ? new Response(null, { status: 302, headers: { location: loc } }) : new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  return { calls, fetchFn };
}
const viaStub = (stub) => ({ ...fakeDeps(), fetchUrl: (u, o) => fetchLimited(u, { ...o, fetchFn: stub.fetchFn }) });
const hydrateUrl = async (stub) => {
  const out = tempDir('ctx-');
  const r = await hydrate({ issue: issue('https://docs.example.com/start'), repo: 'o/r', config, outDir: out }, viaStub(stub));
  return { r, index: readFileSync(path.join(out, 'index.md'), 'utf8'), files: readdirSync(out) };
};

test('a chain of more than 5 redirects on allowed hosts ends as too many redirects', async () => {
  const stub = stubFetch((u, calls) => `https://docs.example.com/hop${calls.length}`);
  const { r, index, files } = await hydrateUrl(stub);
  assert.equal(r.fetched, 0);
  assert.match(index, /\| not fetched: too many redirects \|/);
  assert.deepEqual(files, ['index.md']);
  assert.equal(stub.calls.length, 6);
});

test('a redirect to http, or to an unlisted host, is refused before any request goes to it', async () => {
  for (const target of ['http://docs.example.com/x', 'https://169.254.169.254/latest', 'https://docs.example.com.evil.example/x', 'https://docs.example.com:8443/x']) {
    const stub = stubFetch((u) => (u.endsWith('/start') ? target : null));
    const { r, index } = await hydrateUrl(stub);
    assert.equal(r.fetched, 0, target);
    assert.match(index, /\| not fetched: redirected off allowed hosts \|/, target);
    assert.deepEqual(stub.calls, ['https://docs.example.com/start'], target);
  }
});

test('a relative redirect and a redirect to another listed host are followed; the final URL is the last hop', async () => {
  const stub = stubFetch((u) => (u.endsWith('/start') ? '/next' : u.endsWith('/next') ? 'https://github.com/o/r/readme' : null));
  const r = await fetchLimited('https://docs.example.com/start', { hydrateHosts: config.hydrateHosts, fetchFn: stub.fetchFn });
  assert.equal(r.finalUrl, 'https://github.com/o/r/readme');
  assert.equal(r.body.toString(), 'ok');
});
