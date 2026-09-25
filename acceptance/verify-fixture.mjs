#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ghJson, currentRepo, fetchIssue } from '../skills/ship/scripts/lib/github.mjs';
import { isPipelineComment } from '../skills/ship/scripts/lib/lock.mjs';
import { evaluateFixture, verdictFromComments } from './lib/evaluate.mjs';

const { values } = parseArgs({ options: { sandbox: { type: 'string' }, fixture: { type: 'string' } } });
if (!values.sandbox || !values.fixture) {
  console.error('usage: verify-fixture.mjs --sandbox <dir> --fixture <file.md>');
  process.exit(2);
}
const expected = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'))[values.fixture];
if (!expected) {
  console.error(`no expectations for ${values.fixture}`);
  process.exit(2);
}
const sandbox = path.resolve(values.sandbox);
const recorded = JSON.parse(readFileSync(path.join(sandbox, '.pipeline-fixtures.json'), 'utf8'));
if (!(values.fixture in recorded)) {
  process.stderr.write(`${JSON.stringify({ error: `no issue recorded for ${values.fixture}` })}\n`);
  process.exit(2);
}
const number = recorded[values.fixture];
process.chdir(sandbox);

function isNotFound(err) {
  const text = `${err.stderr ?? ''} ${err.message ?? ''}`;
  return /HTTP 404|Not Found/.test(text);
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
