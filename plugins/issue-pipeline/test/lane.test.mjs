import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { laneTarget } from '../skills/ship/scripts/lib/lane.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { tempDir } from './helpers/git.mjs';

const owner = { login: 'AndresRubio' };
const issue = (over = {}) => ({ number: 5, state: 'open', author_association: 'OWNER', user: owner, labels: [{ name: 'pipeline' }], ...over });
const labeled = (name, iss = issue(), sender = owner) => ({ action: 'labeled', label: { name }, issue: iss, sender });
const commented = (body, iss = issue({ labels: [{ name: 'pipeline' }, { name: 'needs-decision' }] }), assoc = 'OWNER') => ({ action: 'created', issue: iss, comment: { body, author_association: assoc, user: { login: assoc === 'OWNER' ? 'AndresRubio' : 'x' } } });
const prLabeled = (name, over = {}) => ({ action: 'labeled', label: { name }, pull_request: { number: 9, state: 'open', labels: [{ name }], head: { ref: 'pipeline/5-x', repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } }, ...over } });

test('a pipeline or pipeline-go label on a trusted open issue starts a ship run', () => {
  assert.deepEqual(laneTarget({ name: 'issues', payload: labeled('pipeline') }, { openPrs: [] }), { run: true, prompt: '/issue-pipeline:ship #5 --mode auto', key: '5', concurrency: 'ship-5' });
  assert.equal(laneTarget({ name: 'issues', payload: labeled('pipeline-go') }, { openPrs: [] }).run, true);
  assert.equal(laneTarget({ name: 'issues', payload: labeled('bug') }, { openPrs: [] }).run, false);
  assert.match(laneTarget({ name: 'issues', payload: labeled('pipeline', issue({ author_association: 'NONE' })) }, { openPrs: [] }).reason, /author/);
  assert.match(laneTarget({ name: 'issues', payload: labeled('pipeline', issue(), { login: 'stranger' }) }, { openPrs: [] }).reason, /sender/);
  assert.equal(laneTarget({ name: 'issues', payload: labeled('pipeline', issue({ state: 'closed' })) }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'issues', payload: labeled('pipeline', issue({ pull_request: {} })) }, { openPrs: [] }).run, false);
});

test('a trusted reply on a needs-decision issue resumes: a fix run when a pipeline PR is open, else a ship run', () => {
  const noPr = laneTarget({ name: 'issue_comment', payload: commented('go with option 2') }, { openPrs: [] });
  assert.deepEqual(noPr, { run: true, prompt: '/issue-pipeline:ship #5 --mode auto', key: '5', concurrency: 'ship-5' });
  const withPr = laneTarget({ name: 'issue_comment', payload: commented('hide, not delete') }, { openPrs: [{ number: 7, headRefName: 'pipeline/5-archive', isCrossRepository: false, labels: [] }] });
  assert.deepEqual(withPr, { run: true, prompt: '/issue-pipeline:ship 7 --mode auto --fix', key: '5', concurrency: 'ship-5' });
  assert.equal(laneTarget({ name: 'issue_comment', payload: commented('x', issue()) }, { openPrs: [] }).run, false, 'no needs-decision label');
  assert.equal(laneTarget({ name: 'issue_comment', payload: commented('x', undefined, 'NONE') }, { openPrs: [] }).run, false, 'untrusted commenter');
  assert.equal(laneTarget({ name: 'issue_comment', payload: commented('**[issue-pipeline]** blocked · 2026-10-07T10:00:00Z · local\n\nx') }, { openPrs: [] }).run, false, 'pipeline comment');
  const fork = laneTarget({ name: 'issue_comment', payload: commented('x') }, { openPrs: [{ number: 7, headRefName: 'pipeline/5-a', isCrossRepository: true, labels: [] }] });
  assert.equal(fork.prompt, '/issue-pipeline:ship #5 --mode auto', 'a fork PR is not a pipeline PR');
  assert.match(laneTarget({ name: 'issue_comment', payload: commented('x') }, { openPrs: [{ number: 7, headRefName: 'pipeline/5-a', isCrossRepository: false, labels: [{ name: 'needs-local' }] }] }).reason, /needs-local/, 'needs-local PR is not fixed on cloud');
  assert.match(laneTarget({ name: 'issue_comment', payload: commented('x', issue({ labels: [{ name: 'pipeline' }, { name: 'needs-decision' }, { name: 'needs-local' }] })) }, { openPrs: [] }).reason, /needs-local/, 'needs-local issue does not run');
});

test('intake labels on a needs-local issue are ignored', () => {
  assert.match(laneTarget({ name: 'issues', payload: labeled('pipeline', issue({ labels: [{ name: 'pipeline' }, { name: 'needs-local' }] })) }, { openPrs: [] }).reason, /needs-local/);
});

test('missing sender in issues.labeled blocks the run', () => {
  const payloadNoSender = { action: 'labeled', label: { name: 'pipeline' }, issue: issue(), sender: undefined };
  assert.match(laneTarget({ name: 'issues', payload: payloadNoSender }, { openPrs: [] }).reason, /sender/);
});

test('pipeline-fix on a same-repo pipeline PR starts a fix run; needs-local and forks are left alone', () => {
  assert.deepEqual(laneTarget({ name: 'pull_request', payload: prLabeled('pipeline-fix') }, { openPrs: [] }), { run: true, prompt: '/issue-pipeline:ship 9 --mode auto --fix', key: 'PR-9', concurrency: 'ship-PR-9' });
  assert.equal(laneTarget({ name: 'pull_request', payload: prLabeled('ready') }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'pull_request', payload: prLabeled('pipeline-fix', { labels: [{ name: 'pipeline-fix' }, { name: 'needs-local' }] }) }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'pull_request', payload: prLabeled('pipeline-fix', { head: { ref: 'pipeline/5-x', repo: { full_name: 'fork/r' } } }) }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'pull_request', payload: prLabeled('pipeline-fix', { head: { ref: 'feat/x', repo: { full_name: 'o/r' } } }) }, { openPrs: [] }).run, false);
});

test('a pull request reaches a run only through the pipeline-fix label being added', () => {
  // The ship workflow lets its session run a pull request's code (restrict_untrusted_prs is off there),
  // so no other pull request event may be routed, whatever labels the pull request already has.
  const fixLabelled = (action) => ({ ...prLabeled('pipeline-fix', { labels: [{ name: 'pipeline-fix' }] }), action });
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'unlabeled', 'edited', 'closed']) {
    assert.equal(laneTarget({ name: 'pull_request', payload: fixLabelled(action) }, { openPrs: [] }).run, false, action);
  }
  for (const name of ['pull_request_target', 'pull_request_review', 'pull_request_review_comment', 'workflow_run']) {
    assert.equal(laneTarget({ name, payload: fixLabelled('labeled') }, { openPrs: [] }).run, false, name);
  }
});

test('other events never run', () => {
  assert.equal(laneTarget({ name: 'push', payload: {} }, { openPrs: [] }).run, false);
  assert.equal(laneTarget({ name: 'issues', payload: { action: 'opened', issue: issue() } }, { openPrs: [] }).run, false);
});

test('workflow_dispatch from the sweep starts a ship run for the named issue', () => {
  assert.deepEqual(laneTarget({ name: 'workflow_dispatch', payload: { inputs: { issue: '12' } } }), {
    run: true, prompt: '/issue-pipeline:ship #12 --mode auto', key: '12', concurrency: 'ship-12',
  });
  for (const issue of ['', '0', '12a', '-3', ' 12', undefined]) {
    assert.equal(laneTarget({ name: 'workflow_dispatch', payload: { inputs: { issue } } }).run, false, String(issue));
  }
});

test('CLI lane-target reads the event file and lists PRs only for comments', () => {
  const dir = tempDir();
  const file = path.join(dir, 'event.json');
  writeFileSync(file, JSON.stringify(commented('decided')));
  const gh = fakeGh({ 'pr list --repo o/r --state open --limit 500 --json number,headRefName,isCrossRepository,labels': [{ number: 7, headRefName: 'pipeline/5-a', isCrossRepository: false, labels: [] }] });
  const r = runCli(['lane-target', '--event-file', file, '--repo', 'o/r', '--event-name', 'issue_comment'], { env: { PATH: `${gh}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().prompt, '/issue-pipeline:ship 7 --mode auto --fix');
  writeFileSync(file, JSON.stringify(labeled('pipeline')));
  const r2 = runCli(['lane-target', '--event-file', file, '--repo', 'o/r', '--event-name', 'issues'], { env: { PATH: `${fakeGh({})}:${process.env.PATH}` } });
  assert.equal(r2.json().prompt, '/issue-pipeline:ship #5 --mode auto');
});

const botChild = (over = {}) => issue({ number: 28, author_association: 'NONE', user: { login: 'claude[bot]' }, ...over });
const vouching = { number: 4, authorAssociation: 'OWNER', splitInto: [28, 29, 30] };
const session = { login: 'claude[bot]' };

test('a sub-issue its trusted parent split into starts from its label, from pipeline-go, or from a reply', () => {
  assert.equal(laneTarget({ name: 'issues', payload: labeled('pipeline', botChild(), session) }, { parent: vouching }).run, true);
  assert.equal(laneTarget({ name: 'issues', payload: { ...labeled('pipeline-go', botChild(), owner), repository: { owner } } }, { parent: vouching }).run, true);
  assert.match(laneTarget({ name: 'issues', payload: labeled('pipeline', botChild(), session) }, { parent: null }).reason, /issue author is not trusted/);
  assert.match(laneTarget({ name: 'issues', payload: labeled('pipeline', botChild(), session) }, { parent: { ...vouching, splitInto: [29] } }).reason, /issue author is not trusted/);
  const parked = botChild({ labels: [{ name: 'pipeline' }, { name: 'needs-decision' }] });
  assert.equal(laneTarget({ name: 'issue_comment', payload: commented('go ahead', parked) }, { openPrs: [], parent: vouching }).run, true);
});

test('an issue blocked by an open issue does not start from an event', () => {
  const summary = (blocked_by) => ({ issue_dependencies_summary: { blocked_by, total_blocked_by: 1 } });
  assert.match(laneTarget({ name: 'issues', payload: labeled('pipeline', issue(summary(1))) }).reason, /blocked by an open issue/);
  const parked = issue({ ...summary(1), labels: [{ name: 'pipeline' }, { name: 'needs-decision' }] });
  assert.match(laneTarget({ name: 'issue_comment', payload: commented('x', parked) }).reason, /blocked by an open issue/);
  assert.equal(laneTarget({ name: 'issues', payload: labeled('pipeline', issue(summary(0))) }).run, true);
});

test('CLI lane-target reads the parent of a bot-written sub-issue, and fails when it cannot', () => {
  const dir = tempDir();
  const file = path.join(dir, 'event.json');
  writeFileSync(file, JSON.stringify(labeled('pipeline', botChild(), session)));
  const split = { id: 500, user: { login: 'claude[bot]' }, author_association: 'NONE', created_at: '2026-11-13T22:32:10Z', body: '**[issue-pipeline]** split · 2026-11-13T22:32:10Z · local\n\nSplit into: 28, 29, 30' };
  const routes = {
    'api repos/o/r/issues/28': { number: 28, user: { login: 'claude[bot]' }, author_association: 'NONE', parent_issue_url: 'https://api.github.com/repos/o/r/issues/4' },
    'api repos/o/r/issues/4': { number: 4, user: owner, author_association: 'OWNER' },
    'api --paginate --slurp repos/o/r/issues/4/comments': [[split]],
  };
  const ok = runCli(['lane-target', '--event-file', file, '--repo', 'o/r', '--event-name', 'issues'], { env: { PATH: `${fakeGh(routes)}:${process.env.PATH}` } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json().run, true);
  const down = runCli(['lane-target', '--event-file', file, '--repo', 'o/r', '--event-name', 'issues'], { env: { PATH: `${fakeGh({ 'api repos/o/r/issues/28': routes['api repos/o/r/issues/28'] })}:${process.env.PATH}` } });
  assert.equal(down.code, 1);
});

test('a vouched sub-issue still needs a trusted labeller and a trusted commenter', () => {
  assert.match(laneTarget({ name: 'issues', payload: labeled('pipeline', botChild(), { login: 'triager' }) }, { parent: vouching }).reason, /label sender is not the issue author or the repo owner/);
  const parked = botChild({ labels: [{ name: 'pipeline' }, { name: 'needs-decision' }] });
  assert.match(laneTarget({ name: 'issue_comment', payload: commented('go ahead', parked, 'NONE') }, { openPrs: [], parent: vouching }).reason, /commenter is not trusted/);
});

test('laneTarget ignores a parent field that the payload issue carries', () => {
  const forged = botChild({ parent: vouching });
  assert.match(laneTarget({ name: 'issues', payload: labeled('pipeline', forged, session) }, { parent: null }).reason, /issue author is not trusted/);
});

const childRoutes = (parentAssociation) => {
  const split = { id: 500, user: { login: 'claude[bot]' }, author_association: 'NONE', created_at: '2026-11-13T22:32:10Z', body: '**[issue-pipeline]** split · 2026-11-13T22:32:10Z · local\n\nSplit into: 28, 29, 30' };
  return {
    'api repos/o/r/issues/28': { number: 28, user: { login: 'claude[bot]' }, author_association: 'NONE', parent_issue_url: 'https://api.github.com/repos/o/r/issues/4' },
    'api repos/o/r/issues/4': { number: 4, user: owner, author_association: parentAssociation },
    'api --paginate --slurp repos/o/r/issues/4/comments': [[split]],
  };
};

test('CLI lane-target refuses a sub-issue whose parent is not written by a trusted author', () => {
  const dir = tempDir();
  const file = path.join(dir, 'event.json');
  writeFileSync(file, JSON.stringify(labeled('pipeline', botChild(), session)));
  const r = runCli(['lane-target', '--event-file', file, '--repo', 'o/r', '--event-name', 'issues'], { env: { PATH: `${fakeGh(childRoutes('NONE'))}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().run, false);
  assert.match(r.json().reason, /issue author is not trusted/);
});

test('CLI lane-target reads the parent for a reply on a parked bot-written sub-issue', () => {
  const dir = tempDir();
  const file = path.join(dir, 'event.json');
  writeFileSync(file, JSON.stringify(commented('go ahead', botChild({ labels: [{ name: 'pipeline' }, { name: 'needs-decision' }] }))));
  const routes = { 'pr list --repo o/r --state open --limit 500 --json number,headRefName,isCrossRepository,labels': [], ...childRoutes('OWNER') };
  const r = runCli(['lane-target', '--event-file', file, '--repo', 'o/r', '--event-name', 'issue_comment'], { env: { PATH: `${fakeGh(routes)}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().run, true);
});
