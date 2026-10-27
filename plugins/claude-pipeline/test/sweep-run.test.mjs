import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSweep } from '../skills/ship/scripts/lib/sweep-run.mjs';
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
