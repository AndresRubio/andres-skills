import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSweep, latestLabeler } from '../skills/ship/scripts/lib/sweep-run.mjs';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';
import { runCli } from './helpers/cli.mjs';
import { fakeGh } from './helpers/fake-gh.mjs';
import { makeRepoWithOrigin } from './helpers/git.mjs';

const NOW = new Date('2026-10-20T12:00:00Z');
const config = validateConfig({ tracker: { type: 'github' }, maxParallel: 2 });
const marked = (id, kind, at, text = '') => ({
  id, author: 'AndresRubio', authorAssociation: 'OWNER', createdAt: at,
  body: `**[claude-pipeline]** ${kind} · ${at} · local\n\n${text}`, marker: { kind, at, run: 'local' }, pipeline: true, trusted: true,
});
const deferredIssue = {
  number: 5, title: 't', body: '', state: 'open', author: 'AndresRubio', authorAssociation: 'OWNER', isPullRequest: false,
  labels: ['claude'], openBlockedBy: [], openSubIssues: [], createdAt: '2026-10-20T08:00:00Z',
  comments: [marked(11, 'lock', '2026-10-20T10:00:00Z', 'Run started'), marked(12, 'deferred', '2026-10-20T10:01:00Z', 'Deferred: 2 runs are ahead of this one.')],
};

function deps({ dispatchError } = {}) {
  const dispatched = [];
  return {
    dispatched,
    deps: {
      listIssueNumbers: (label) => (label === 'claude' ? [5] : []),
      fetchIssue: () => deferredIssue,
      listOpenPrs: () => [],
      listClosedPrs: () => [],
      dispatch: (n) => { if (dispatchError) throw new Error(dispatchError); dispatched.push(n); },
    },
  };
}

test('runSweep dispatches claude-ship for each candidate', () => {
  const { deps: d, dispatched } = deps();
  const r = runSweep({ config, now: NOW }, d);
  assert.deepEqual(dispatched, [5]);
  assert.deepEqual(r.started, [{ issue: 5, done: 'dispatched claude-ship' }]);
  assert.deepEqual(r.errors, []);
});

test('runSweep: dry run dispatches nothing; disabled does nothing; a failed dispatch is collected', () => {
  const dry = deps();
  assert.deepEqual(runSweep({ config, now: NOW, dryRun: true }, dry.deps).started, [{ issue: 5, done: 'would dispatch claude-ship' }]);
  assert.deepEqual(dry.dispatched, []);
  assert.equal(runSweep({ config: { ...config, enabled: false }, now: NOW }, deps().deps).disabled, true);
  const broken = runSweep({ config, now: NOW }, deps({ dispatchError: 'HTTP 403' }).deps);
  assert.deepEqual(broken.errors, [{ issue: 5, error: 'HTTP 403' }]);
});

test('CLI sweep reads the default-branch config, fetches through gh and dispatches', () => {
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, maxParallel: 2 }) });
  const apiComment = (id, kind, at, text) => ({ id, user: { login: 'AndresRubio' }, author_association: 'OWNER', created_at: at, body: `**[claude-pipeline]** ${kind} · ${at} · local\n\n${text}` });
  const routes = {
    'issue list --repo o/r --state open --label claude --limit 500 --json number': [{ number: 5 }],
    'issue list --repo o/r --state open --label claude-working --limit 500 --json number': [],
    'api repos/o/r/issues/5': { number: 5, id: 1, node_id: 'n', title: 't', body: '', state: 'open', html_url: 'https://github.com/o/r/issues/5', user: { login: 'AndresRubio' }, author_association: 'OWNER', labels: [{ name: 'claude' }], created_at: '2026-10-20T08:00:00Z' },
    'api --paginate --slurp repos/o/r/issues/5/comments': [[apiComment(11, 'lock', '2026-10-20T10:00:00Z', 'Run started'), apiComment(12, 'deferred', '2026-10-20T10:01:00Z', 'Deferred: 2 runs are ahead of this one.')]],
    'api repos/o/r/issues/5/dependencies/blocked_by': [],
    'api repos/o/r/issues/5/sub_issues': [],
    'pr list --repo o/r --state open --limit 500 --json number,headRefName,isCrossRepository,title': [],
    'pr list --repo o/r --state all --limit 200 --json number,headRefName,isCrossRepository,state,closedAt,mergedAt': [],
    'workflow run claude-ship.yml --repo o/r -f issue=5': '',
  };
  const ok = runCli(['sweep', '--repo', 'o/r', '--repo-root', root, '--now', '2026-10-20T12:00:00Z'], { env: { PATH: `${fakeGh(routes)}:${process.env.PATH}` } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.json().started, [{ issue: 5, done: 'dispatched claude-ship' }]);
  const failing = { ...routes, 'workflow run claude-ship.yml --repo o/r -f issue=5': { __ghError: 'HTTP 403: Resource not accessible by integration' } };
  const bad = runCli(['sweep', '--repo', 'o/r', '--repo-root', root, '--now', '2026-10-20T12:00:00Z'], { env: { PATH: `${fakeGh(failing)}:${process.env.PATH}` } });
  assert.equal(bad.code, 1);
  assert.match(bad.json().errors[0].error, /HTTP 403/);
});

const freshIssue = (number, over = {}) => ({ ...deferredIssue, number, comments: [], createdAt: `2026-10-20T0${number}:00:00Z`, ...over });
function many(issues, over = {}) {
  const dispatched = [];
  const labelFetches = [];
  return {
    dispatched, labelFetches,
    deps: {
      owner: 'AndresRubio',
      listIssueNumbers: (label) => (label === 'claude' ? Object.keys(issues).map(Number) : []),
      fetchIssue: (n) => { const i = issues[n]; if (i instanceof Error) throw i; return i; },
      fetchLabeledBy: (n) => { labelFetches.push(n); return 'AndresRubio'; },
      listOpenPrs: () => [],
      listClosedPrs: () => [],
      dispatch: (n) => { dispatched.push(n); },
      ...over,
    },
  };
}
const wide = validateConfig({ tracker: { type: 'github' }, maxParallel: 9 });

test('latestLabeler: the newest labeled event for the label, or null', () => {
  const ev = (event, name, login) => ({ event, label: { name }, actor: { login } });
  assert.equal(latestLabeler([ev('labeled', 'claude', 'a'), ev('labeled', 'bug', 'b'), ev('labeled', 'claude', 'c'), ev('unlabeled', 'claude', 'd')], 'claude'), 'c');
  assert.equal(latestLabeler([ev('labeled', 'bug', 'b'), { event: 'commented' }], 'claude'), null);
  assert.equal(latestLabeler([], 'claude'), null);
  // Events are ordered by created_at, not by their position in the response; ties keep the response order.
  const at = (login, created_at) => ({ ...ev('labeled', 'claude', login), created_at });
  assert.equal(latestLabeler([at('late', '2026-10-20T12:00:00Z'), at('early', '2026-10-20T10:00:00Z')], 'claude'), 'late');
  assert.equal(latestLabeler([at('first', '2026-10-20T10:00:00Z'), at('second', '2026-10-20T10:00:00Z')], 'claude'), 'second');
  assert.equal(latestLabeler([at('dated', '2026-10-20T10:00:00Z'), ev('labeled', 'claude', 'undated')], 'claude'), 'dated');
});

test('runSweep: a triage user labelled a trusted author\'s issue, so the sweep does not dispatch it', () => {
  const issue = freshIssue(1, { author: 'friend', authorAssociation: 'COLLABORATOR' });
  const m = many({ 1: issue }, { fetchLabeledBy: () => 'triager' });
  const r = runSweep({ config: wide, now: NOW }, m.deps);
  assert.deepEqual(m.dispatched, []);
  assert.deepEqual(r.started, []);
  assert.equal(r.skipped[0].why, 'label sender is not the issue author or the repo owner');
  // The owner labelling the same issue does start it.
  const ok = many({ 1: issue }, { fetchLabeledBy: () => 'AndresRubio' });
  runSweep({ config: wide, now: NOW }, ok.deps);
  assert.deepEqual(ok.dispatched, [1]);
});

test('runSweep: events are fetched only for open claude issues no run has touched, and the fetched issue is not mutated', () => {
  const touched = freshIssue(2, { comments: deferredIssue.comments });
  const closed = freshIssue(3, { state: 'closed' });
  const fresh = freshIssue(4);
  const m = many({ 2: touched, 3: closed, 4: fresh });
  runSweep({ config: wide, now: NOW }, m.deps);
  assert.deepEqual(m.labelFetches, [4]);
  assert.equal('labeledBy' in fresh, false);
});

test('runSweep: one failing issue fetch (a 404) becomes an errors entry and the rest of the sweep goes on', () => {
  const notFound = Object.assign(new Error('gh failed'), { stderr: 'HTTP 404: Not Found\n' });
  const m = many({ 1: freshIssue(1), 2: notFound, 3: freshIssue(3) });
  const r = runSweep({ config: wide, now: NOW }, m.deps);
  assert.deepEqual(r.errors, [{ issue: 2, error: 'HTTP 404: Not Found' }]);
  assert.deepEqual(m.dispatched, [1, 3]);
  assert.deepEqual(r.started.map((x) => x.issue), [1, 3]);
});

test('runSweep: a dispatch that throws mid-list is an error entry; earlier dispatches stay recorded and later ones are still attempted', () => {
  const m = many({ 1: freshIssue(1), 2: freshIssue(2), 3: freshIssue(3) }, {
    dispatch: (n) => { if (n === 2) throw new Error('HTTP 502'); m.dispatched.push(n); },
  });
  const r = runSweep({ config: wide, now: NOW }, m.deps);
  assert.deepEqual(r.started.map((x) => x.issue), [1, 3]);
  assert.deepEqual(r.errors, [{ issue: 2, error: 'HTTP 502' }]);
  assert.deepEqual(m.dispatched, [1, 3]);
});

test('CLI sweep: a new issue labelled by its author is dispatched; one labelled by a triage user is not', () => {
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, maxParallel: 2 }) });
  const issue = { number: 6, id: 1, node_id: 'n', title: 't', body: '', state: 'open', html_url: 'https://github.com/o/r/issues/6', user: { login: 'friend' }, author_association: 'COLLABORATOR', labels: [{ name: 'claude' }], created_at: '2026-10-20T08:00:00Z' };
  const events = (login) => [[{ event: 'labeled', label: { name: 'claude' }, actor: { login: 'someone' } }, { event: 'labeled', label: { name: 'claude' }, actor: { login } }]];
  const routes = (login) => ({
    'issue list --repo o/r --state open --label claude --limit 500 --json number': [{ number: 6 }],
    'issue list --repo o/r --state open --label claude-working --limit 500 --json number': [],
    'api repos/o/r/issues/6': issue,
    'api --paginate --slurp repos/o/r/issues/6/comments': [[]],
    'api repos/o/r/issues/6/dependencies/blocked_by': [],
    'api repos/o/r/issues/6/sub_issues': [],
    'api --paginate --slurp repos/o/r/issues/6/events': events(login),
    'pr list --repo o/r --state open --limit 500 --json number,headRefName,isCrossRepository,title': [],
    'pr list --repo o/r --state all --limit 200 --json number,headRefName,isCrossRepository,state,closedAt,mergedAt': [],
    'workflow run claude-ship.yml --repo o/r -f issue=6': '',
  });
  const run = (login, extra = []) => runCli(['sweep', '--repo', 'o/r', '--repo-root', root, '--now', '2026-10-20T12:00:00Z', ...extra], { env: { PATH: `${fakeGh(routes(login))}:${process.env.PATH}` } });
  const byAuthor = run('friend');
  assert.equal(byAuthor.code, 0, byAuthor.stderr);
  assert.deepEqual(byAuthor.json().started, [{ issue: 6, done: 'dispatched claude-ship' }]);
  const byOwner = run('o');
  assert.deepEqual(byOwner.json().started, [{ issue: 6, done: 'dispatched claude-ship' }]);
  const byTriager = run('triager');
  assert.equal(byTriager.code, 0, byTriager.stderr);
  assert.deepEqual(byTriager.json().started, []);
  assert.equal(byTriager.json().skipped[0].why, 'label sender is not the issue author or the repo owner');
});

test('CLI sweep --dry-run dispatches nothing', () => {
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, maxParallel: 2 }) });
  const apiComment = (id, kind, at, text) => ({ id, user: { login: 'AndresRubio' }, author_association: 'OWNER', created_at: at, body: `**[claude-pipeline]** ${kind} · ${at} · local\n\n${text}` });
  // No route for `workflow run`: the fake gh exits 1 on an unrouted call, so any dispatch would fail the run.
  const routes = {
    'issue list --repo o/r --state open --label claude --limit 500 --json number': [{ number: 5 }],
    'issue list --repo o/r --state open --label claude-working --limit 500 --json number': [],
    'api repos/o/r/issues/5': { number: 5, id: 1, node_id: 'n', title: 't', body: '', state: 'open', html_url: 'https://github.com/o/r/issues/5', user: { login: 'AndresRubio' }, author_association: 'OWNER', labels: [{ name: 'claude' }], created_at: '2026-10-20T08:00:00Z' },
    'api --paginate --slurp repos/o/r/issues/5/comments': [[apiComment(11, 'lock', '2026-10-20T10:00:00Z', 'Run started'), apiComment(12, 'deferred', '2026-10-20T10:01:00Z', 'Deferred: 2 runs are ahead of this one.')]],
    'api repos/o/r/issues/5/dependencies/blocked_by': [],
    'api repos/o/r/issues/5/sub_issues': [],
    'pr list --repo o/r --state open --limit 500 --json number,headRefName,isCrossRepository,title': [],
    'pr list --repo o/r --state all --limit 200 --json number,headRefName,isCrossRepository,state,closedAt,mergedAt': [],
  };
  const r = runCli(['sweep', '--repo', 'o/r', '--repo-root', root, '--dry-run', '--now', '2026-10-20T12:00:00Z'], { env: { PATH: `${fakeGh(routes)}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json().started, [{ issue: 5, done: 'would dispatch claude-ship' }]);
  assert.deepEqual(r.json().errors, []);
});
