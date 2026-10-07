#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ghJson, currentRepo, fetchIssue, fetchPrComments } from '../skills/ship/scripts/lib/github.mjs';
import { isPipelineComment } from '../skills/ship/scripts/lib/lock.mjs';
import { latestVerdict } from '../skills/ship/scripts/lib/verdict.mjs';
import { evaluateFixture, findLeaks, verdictFromComments } from './lib/evaluate.mjs';

// A usage error: JSON on stderr, exit 2.
function usageError(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(2);
}

const { values } = parseArgs({ options: { sandbox: { type: 'string' }, fixture: { type: 'string' }, 'forbidden-file': { type: 'string' } } });
if (!values.sandbox || !values.fixture) {
  console.error('usage: verify-fixture.mjs --sandbox <dir> --fixture <file.md> [--forbidden-file <path>]');
  process.exit(2);
}
// Object.hasOwn, not `in` or a bracket-lookup truthiness check: both fixtures.json
// and the sandbox's recorded-issue map are looked up by a name that comes straight
// off argv, and `in`/`[key]` walk the prototype chain — `--fixture constructor`
// would otherwise resolve to Object.prototype.constructor instead of failing clean.
const allFixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
if (!Object.hasOwn(allFixtures, values.fixture)) {
  console.error(`no expectations for ${values.fixture}`);
  process.exit(2);
}
const expected = allFixtures[values.fixture];
const sandbox = path.resolve(values.sandbox);
let recorded;
try {
  recorded = JSON.parse(readFileSync(path.join(sandbox, '.pipeline-fixtures.json'), 'utf8'));
} catch (err) {
  usageError(`cannot read ${path.join(sandbox, '.pipeline-fixtures.json')}: ${err.message}`);
}
if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) {
  usageError(`${path.join(sandbox, '.pipeline-fixtures.json')} is not a JSON object`);
}
// A fixture may reuse another fixture's seeded issue (`issueFile`): 14 runs issue 01 with the review secret broken.
const issueFile = expected.issueFile ?? values.fixture;
if (!Object.hasOwn(recorded, issueFile)) {
  usageError(`no issue recorded for ${issueFile}`);
}
const number = recorded[issueFile];

// A noLeak fixture scans the whole public repo for text that must stay private (the
// private sandbox's CANARY.md). The text comes from a file so it never appears in argv
// or in this script's output. All of this is checked before any GitHub call.
let forbidden = null;
if (expected.noLeak) {
  if (!values['forbidden-file']) usageError(`${values.fixture} needs --forbidden-file <path> (the private marker to search the public repo for)`);
  try {
    forbidden = readFileSync(values['forbidden-file'], 'utf8').trim();
  } catch (err) {
    usageError(`cannot read ${values['forbidden-file']}: ${err.message}`);
  }
  if (forbidden.length < 16) usageError(`${values['forbidden-file']} must hold at least 16 characters of text (a shorter marker could match by accident)`);
}
process.chdir(sandbox);

function isNotFound(err) {
  const text = `${err.stderr ?? ''} ${err.message ?? ''}`;
  return /HTTP 404|Not Found/.test(text);
}

// Every public text on the repo that could carry the private marker:
//   - issue and PR titles and bodies, issue/PR comments, PR reviews, review comments, commit comments;
//   - for every branch except the default: each commit's message and patch, the net diff against the
//     default branch, and the raw content (blob) of any file GitHub gives no patch for (binaries, huge diffs).
// Per-commit patches matter: a marker committed and then removed is gone from the net diff but stays public.
// GitHub's compare and commit responses are capped (250 commits, 300 files), so a branch that hits a cap
// can't be fully scanned and the run fails with exit 3 rather than reporting a clean result.
// Not scanned: the edit history of comments and bodies.
const MAX_FILES = 300;

function publicTexts(repo, branches) {
  const paged = (endpoint) => ghJson(['api', '--paginate', '--slurp', endpoint]).flat();
  const texts = [];
  const issues = paged(`repos/${repo}/issues?state=all&per_page=100`);
  for (const i of issues) {
    texts.push({ where: `issue #${i.number} title`, text: i.title }, { where: `issue #${i.number} body`, text: i.body });
  }
  for (const i of issues.filter((x) => x.pull_request)) {
    for (const r of paged(`repos/${repo}/pulls/${i.number}/reviews`)) texts.push({ where: `review ${r.html_url}`, text: r.body });
  }
  for (const c of paged(`repos/${repo}/issues/comments?per_page=100`)) texts.push({ where: `comment ${c.html_url}`, text: c.body });
  for (const c of paged(`repos/${repo}/pulls/comments?per_page=100`)) texts.push({ where: `review comment ${c.html_url}`, text: c.body });
  for (const c of paged(`repos/${repo}/comments?per_page=100`)) texts.push({ where: `commit comment ${c.html_url}`, text: c.body });

  const defaultBranch = ghJson(['api', `repos/${repo}`]).default_branch;
  const commitCache = new Map();
  const blobCache = new Map();
  const commit = (sha) => {
    if (!commitCache.has(sha)) commitCache.set(sha, ghJson(['api', `repos/${repo}/commits/${sha}`]));
    return commitCache.get(sha);
  };
  const blob = (sha) => {
    if (!blobCache.has(sha)) {
      const b = ghJson(['api', `repos/${repo}/git/blobs/${sha}`]);
      blobCache.set(sha, b.encoding === 'base64' ? Buffer.from(b.content, 'base64').toString('utf8') : b.content);
    }
    return blobCache.get(sha);
  };

  for (const name of branches.filter((b) => b !== defaultBranch)) {
    const cannot = (why) => new Error(`cannot scan all of branch ${name}: ${why}`);
    const seenBlobs = new Set();
    const filesOf = (result, what) => {
      const files = result.files ?? [];
      if (files.length >= MAX_FILES) throw cannot(`${what} lists ${files.length} files and GitHub returns at most ${MAX_FILES}`);
      return files;
    };
    // A patch is text; a file with no patch (and not deleted) is read as a blob instead.
    const addFile = (f, patchWhere) => {
      if (typeof f.patch === 'string') {
        texts.push({ where: patchWhere, text: f.patch });
      } else if (f.status !== 'removed') {
        const where = `branch ${name} file ${f.filename} (blob)`;
        if (seenBlobs.has(`${where}\0${f.sha}`)) return;
        seenBlobs.add(`${where}\0${f.sha}`);
        texts.push({ where, text: blob(f.sha) });
      }
    };

    // The branch name goes in unencoded: GitHub accepts slashes in compare refs.
    const compare = ghJson(['api', `repos/${repo}/compare/${defaultBranch}...${name}`]);
    const commits = compare.commits ?? [];
    if ((compare.total_commits ?? commits.length) > commits.length) {
      throw cannot(`compare lists ${commits.length} of ${compare.total_commits} commits`);
    }
    for (const f of filesOf(compare, 'the compare')) addFile(f, `branch ${name} file ${f.filename}`);
    for (const c of commits) {
      const sha7 = c.sha.slice(0, 7);
      texts.push({ where: `branch ${name} commit ${sha7}`, text: c.commit.message });
      for (const f of filesOf(commit(c.sha), `commit ${sha7}`)) addFile(f, `branch ${name} commit ${sha7} file ${f.filename}`);
    }
  }
  return texts;
}

let observed;
try {
  const repo = currentRepo();
  const issue = fetchIssue(repo, number);
  const pipelineComments = issue.comments.filter(isPipelineComment);
  const isOurs = (name) => name === `claude/${number}` || name.startsWith(`claude/${number}-`);
  const pr = ghJson(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '500', '--json', 'number,url,headRefName,body'])
    .find((p) => isOurs(p.headRefName)) ?? null;
  const branches = ghJson(['api', '--paginate', '--slurp', `repos/${repo}/branches`]).flat().map((b) => b.name);
  const list = (dir, ref) => {
    try {
      return ghJson(['api', `repos/${repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`]).map((e) => e.name);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  };
  observed = {
    verdict: verdictFromComments(pipelineComments),
    pr,
    labels: issue.labels,
    commentKinds: pipelineComments.map((c) => c.marker.kind),
    artifacts: pr ? list(`docs/pipeline/${number}`, pr.headRefName) : [],
    screenshots: pr ? list(`docs/pipeline/${number}/screenshots`, pr.headRefName).filter((f) => f.endsWith('.png')).length : 0,
    subIssues: issue.openSubIssues.length,
    branchPushed: branches.some(isOurs),
    issueNumber: number,
  };
  observed.fixRuns = issue.comments.filter((c) => c.pipeline && c.marker.kind === 'lock' && c.body.split('\n').slice(1).join('\n').trim().startsWith('Fix run started')).length;
  if (pr) {
    const prView = ghJson(['pr', 'view', String(pr.number), '--json', 'labels,headRefOid']);
    observed.prLabels = prView.labels.map((l) => l.name);
    const prComments = fetchPrComments(repo, pr.number);
    observed.prCommentKinds = prComments.filter((c) => c.pipeline).map((c) => c.marker.kind);
    observed.reviewVerdict = latestVerdict(prComments, prView.headRefOid)?.verdict ?? null;
    observed.readyReport = prComments.filter((c) => c.pipeline && c.marker.kind === 'ready').at(-1)?.body ?? '';
  }
  if (expected.noLeak) observed.leaks = findLeaks(publicTexts(repo, branches), forbidden);
} catch (err) {
  process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
  process.exit(3);
}
const result = evaluateFixture(expected, observed);
console.log(JSON.stringify({
  fixture: values.fixture, issue: number, ...result,
  observed: { ...observed, pr: observed.pr && { url: observed.pr.url, headRefName: observed.pr.headRefName } },
}, null, 2));
process.exit(result.pass ? 0 : 1);
