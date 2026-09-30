#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ghJson, currentRepo, fetchIssue } from '../skills/ship/scripts/lib/github.mjs';
import { isPipelineComment } from '../skills/ship/scripts/lib/lock.mjs';
import { evaluateFixture, findLeaks, verdictFromComments } from './lib/evaluate.mjs';

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
  process.stderr.write(`${JSON.stringify({ error: `cannot read ${path.join(sandbox, '.pipeline-fixtures.json')}: ${err.message}` })}\n`);
  process.exit(2);
}
if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) {
  process.stderr.write(`${JSON.stringify({ error: `${path.join(sandbox, '.pipeline-fixtures.json')} is not a JSON object` })}\n`);
  process.exit(2);
}
if (!Object.hasOwn(recorded, values.fixture)) {
  process.stderr.write(`${JSON.stringify({ error: `no issue recorded for ${values.fixture}` })}\n`);
  process.exit(2);
}
const number = recorded[values.fixture];

function usageError(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(2);
}

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

// Every public text on the repo that could carry the private marker: issue and PR titles and
// bodies, issue/PR comments, review comments, and the commits and patches of this issue's branches.
function publicTexts(repo, ourBranches) {
  const paged = (endpoint) => ghJson(['api', '--paginate', '--slurp', endpoint]).flat();
  const texts = [];
  for (const i of paged(`repos/${repo}/issues?state=all&per_page=100`)) {
    texts.push({ where: `issue #${i.number} title`, text: i.title }, { where: `issue #${i.number} body`, text: i.body });
  }
  for (const c of paged(`repos/${repo}/issues/comments?per_page=100`)) texts.push({ where: `comment ${c.html_url}`, text: c.body });
  for (const c of paged(`repos/${repo}/pulls/comments?per_page=100`)) texts.push({ where: `review comment ${c.html_url}`, text: c.body });
  if (ourBranches.length > 0) {
    const defaultBranch = ghJson(['api', `repos/${repo}`]).default_branch;
    for (const name of ourBranches) {
      // The branch name goes in unencoded: GitHub accepts slashes in compare refs.
      const compare = ghJson(['api', `repos/${repo}/compare/${defaultBranch}...${name}`]);
      for (const c of compare.commits ?? []) texts.push({ where: `branch ${name} commit ${c.sha.slice(0, 7)}`, text: c.commit.message });
      for (const f of compare.files ?? []) texts.push({ where: `branch ${name} file ${f.filename}`, text: f.patch });
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
  if (expected.noLeak) observed.leaks = findLeaks(publicTexts(repo, branches.filter(isOurs)), forbidden);
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
