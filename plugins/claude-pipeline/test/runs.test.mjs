import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASING_KINDS, DECISION_KINDS, KEY_RE, runLock, compareKeys, waitingFor, activeRuns,
} from '../skills/ship/scripts/lib/runs.mjs';

const NOW = new Date('2026-10-06T12:00:00Z');
const TTL = 3;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const minutesAgo = (m) => iso(NOW.getTime() - m * 60_000);

const comment = (kind, createdAt, id, { body = '', author = 'AndresRubio', authorAssociation = 'OWNER' } = {}) => ({
  id,
  author,
  authorAssociation,
  createdAt,
  body: kind ? `**[claude-pipeline]** ${kind} · ${createdAt} · local\n\n${body}` : body,
  marker: kind ? { kind, at: createdAt, run: 'local' } : null,
});
const lock = (createdAt, id, branch = null, extra = {}) => comment('lock', createdAt, id, {
  body: branch === null ? 'Fix run started — lane github, mode auto, PR #1.' : `Run started — lane github, mode auto, branch \`${branch}\`.`,
  ...extra,
});
const makeIssue = (number, over = {}) => ({
  number, title: `Issue ${number}`, body: `Body of ${number}`, state: 'open',
  author: 'AndresRubio', authorAssociation: 'OWNER', labels: ['claude', 'claude-working'],
  openBlockedBy: [], openSubIssues: [], comments: [], ...over,
});
const locked = (number, createdAt, id, over = {}) => makeIssue(number, { comments: [lock(createdAt, id, `claude/${number}-x`)], ...over });
const runLockOf = (issue) => runLock(issue, { ttlHours: TTL, now: NOW });
const view = ({ prs = [], lockedIssues = [], selfIssue = makeIssue(5), maxParallel = 2 } = {}) => activeRuns({
  prs, lockedIssues, selfIssue, ttlHours: TTL, maxParallel, now: NOW,
});
const pr = (number, headRefName, over = {}) => ({ number, headRefName, isCrossRepository: false, title: `PR ${number}`, ...over });

test('the kind lists and the key pattern are the ones D16 names', () => {
  assert.deepEqual([...RELEASING_KINDS], ['report', 'blocked', 'questions', 'split', 'deferred', 'stale-lock']);
  assert.deepEqual([...DECISION_KINDS], ['grade', 'questions', 'split', 'report', 'blocked', 'deferred']);
  for (const key of ['5', '123', 'lin-42', 'abc1-7', 'pr-12', 'PR-12']) assert.match(key, KEY_RE);
  for (const key of ['#5', 'PR12', 'Pr-12', 'PR-x', 'pr12', 'abc', '5 ', '-5', 'Lin-4', '$(x)']) assert.doesNotMatch(key, KEY_RE);
});

// --- runLock ---

test('runLock: none without the claude-working label', () => {
  const issue = makeIssue(5, { labels: ['claude'], comments: [lock(minutesAgo(10), 1, 'claude/5-x')] });
  assert.deepEqual(runLockOf(issue), { state: 'none', lockedAt: null, lockId: null, branch: null });
});

test('runLock: entering when the latest lock is older than a deferred', () => {
  const issue = makeIssue(5, { comments: [lock(minutesAgo(30), 1, 'claude/5-x'), comment('deferred', minutesAgo(29), 2)] });
  assert.deepEqual(runLockOf(issue), { state: 'entering', lockedAt: null, lockId: null, branch: null });
});

test('runLock: with two fresh locks after the latest releasing comment, the first counts', () => {
  const issue = makeIssue(5, {
    comments: [
      lock(minutesAgo(150), 10, 'claude/5-old'),
      comment('report', minutesAgo(120), 11),
      lock(minutesAgo(60), 12, 'claude/5-first'),
      lock(minutesAgo(30), 13, 'claude/5-second'),
    ],
  });
  assert.deepEqual(runLockOf(issue), { state: 'locked', lockedAt: minutesAgo(60), lockId: 12, branch: 'claude/5-first' });
});

test('runLock: a takeover after a stale lock, with no releasing comment between, gives the fresh lock', () => {
  const issue = makeIssue(5, { comments: [lock(minutesAgo(600), 1, 'claude/5-old'), lock(minutesAgo(20), 2, 'claude/5-new')] });
  assert.deepEqual(runLockOf(issue), { state: 'locked', lockedAt: minutesAgo(20), lockId: 2, branch: 'claude/5-new' });
});

test('runLock: every candidate stale gives none', () => {
  const issue = makeIssue(5, { comments: [lock(minutesAgo(600), 1, 'claude/5-a'), lock(minutesAgo(400), 2, 'claude/5-b')] });
  assert.deepEqual(runLockOf(issue), { state: 'none', lockedAt: null, lockId: null, branch: null });
});

test('runLock: a lock exactly lockTtlHours old still counts; one second older does not', () => {
  const edge = makeIssue(5, { comments: [lock(minutesAgo(TTL * 60), 1, 'claude/5-x')] });
  assert.equal(runLockOf(edge).state, 'locked');
  const older = makeIssue(5, { comments: [lock(iso(NOW.getTime() - TTL * 3_600_000 - 1000), 1, 'claude/5-x')] });
  assert.equal(runLockOf(older).state, 'none');
});

test('runLock: lock and releasing comments from an untrusted author are ignored', () => {
  const stranger = { author: 'stranger', authorAssociation: 'NONE' };
  assert.equal(runLockOf(makeIssue(5, { comments: [lock(minutesAgo(10), 1, 'claude/5-x', stranger)] })).state, 'entering');
  const mixed = makeIssue(5, { comments: [lock(minutesAgo(30), 1, 'claude/5-fake', stranger), lock(minutesAgo(20), 2, 'claude/5-real')] });
  assert.equal(runLockOf(mixed).lockId, 2);
  const fakeRelease = makeIssue(5, { comments: [lock(minutesAgo(30), 1, 'claude/5-x'), comment('deferred', minutesAgo(20), 2, stranger)] });
  assert.equal(runLockOf(fakeRelease).lockId, 1);
  const bot = makeIssue(5, { comments: [lock(minutesAgo(10), 1, 'claude/5-x', { author: 'claude[bot]', authorAssociation: 'NONE' })] });
  assert.equal(runLockOf(bot).state, 'locked');
});

test('runLock: candidates are the locks whose id is above the latest releasing id, whatever the times say', () => {
  // GitHub ids grow with time, but the rule is by id: a lock with a smaller id than a report is not a candidate.
  const issue = makeIssue(5, { comments: [comment('report', minutesAgo(40), 9), lock(minutesAgo(30), 8, 'claude/5-x')] });
  assert.equal(runLockOf(issue).state, 'entering');
  const reversed = makeIssue(5, { comments: [lock(minutesAgo(30), 20, 'claude/5-later'), lock(minutesAgo(10), 19, 'claude/5-earlier-id')] });
  assert.deepEqual(runLockOf(reversed), { state: 'locked', lockedAt: minutesAgo(10), lockId: 19, branch: 'claude/5-earlier-id' });
});

test('runLock: the branch is parsed when valid, null with shell characters, and claude/../x still parses', () => {
  const withBody = (body) => runLockOf(makeIssue(5, { comments: [comment('lock', minutesAgo(10), 1, { body })] })).branch;
  assert.equal(withBody('Run started — lane github, mode auto, branch `claude/5-add-filter_v2.1`.'), 'claude/5-add-filter_v2.1');
  assert.equal(withBody('Run started — lane github, mode auto, branch `claude/5-x$(rm -rf ~)`.'), null);
  assert.equal(withBody('Run started — lane github, mode auto, branch `claude/5-x;ls`.'), null);
  assert.equal(withBody('Run started — lane github, mode auto, branch `claude/5 x`.'), null);
  assert.equal(withBody('Run started — lane github, mode auto, branch `main`.'), null);
  assert.equal(withBody('Fix run started — lane github, mode auto, PR #9.'), null);
  assert.equal(withBody('Run started — lane github, mode auto, branch `claude/../x`.'), 'claude/../x');
});

// --- waitingFor ---

const WAIT_TEXT = '**Verdict:** `wait`\n\nThis issue becomes eligible again once none of these runs is in progress.';
const deferred = (createdAt, id, lastLine, extra = {}) => comment('deferred', createdAt, id, { body: lastLine === null ? WAIT_TEXT : `${WAIT_TEXT}\n${lastLine}`, ...extra });
const waitOf = (comments) => waitingFor(makeIssue(5, { labels: ['claude'], comments }));

test('waitingFor: the keys come from the last line', () => {
  assert.deepEqual(waitOf([deferred(minutesAgo(10), 1, 'Waiting for: 7, 12')]), ['7', '12']);
  assert.deepEqual(waitOf([deferred(minutesAgo(10), 1, 'Waiting for: lin-4')]), ['lin-4']);
});

test('waitingFor: trailing spaces and CRLF line ends still parse; duplicate keys are removed', () => {
  const body = `${WAIT_TEXT.replace(/\n/g, '\r\n')}\r\nWaiting for: 7 ,  12,7   \r\n\r\n`;
  assert.deepEqual(waitOf([comment('deferred', minutesAgo(10), 1, { body })]), ['7', '12']);
});

test('waitingFor: a line wrapped in backticks gives [], so the stage must copy waitLine verbatim', () => {
  assert.deepEqual(waitOf([deferred(minutesAgo(10), 1, '`Waiting for: 7`')]), []);
  assert.deepEqual(waitOf([deferred(minutesAgo(10), 1, '**Waiting for: 7**')]), []);
});

test('waitingFor: a later grade or report ends the wait', () => {
  const wait = deferred(minutesAgo(30), 1, 'Waiting for: 7');
  assert.deepEqual(waitOf([wait, comment('grade', minutesAgo(10), 2)]), []);
  assert.deepEqual(waitOf([wait, comment('report', minutesAgo(10), 2)]), []);
});

test('waitingFor: a back-off deferred, with no Waiting for line, gives []', () => {
  const backOff = comment('deferred', minutesAgo(10), 2, { body: 'Deferred: 2 runs are ahead of this one (#7, #8) and `maxParallel` is 2.' });
  assert.deepEqual(waitOf([deferred(minutesAgo(30), 1, 'Waiting for: 7'), backOff]), []);
});

test('waitingFor: a Waiting for line that is not the last line is ignored', () => {
  assert.deepEqual(waitOf([deferred(minutesAgo(10), 1, 'Waiting for: 7\nAnd one more line.')]), []);
});

test('waitingFor: invalid keys are dropped', () => {
  assert.deepEqual(waitOf([deferred(minutesAgo(10), 1, 'Waiting for: 7, #9, abc, PR-3, Pr-4, pr-12, lin-4, $(x), ')]), ['7', 'PR-3', 'pr-12', 'lin-4']);
});

test('waitingFor: a later lock does not end the wait', () => {
  assert.deepEqual(waitOf([deferred(minutesAgo(30), 1, 'Waiting for: 7'), lock(minutesAgo(10), 2, 'claude/5-x')]), ['7']);
});

test('waitingFor: picks by largest id, ignores untrusted comments, and is [] with no decision comment', () => {
  assert.deepEqual(waitOf([]), []);
  assert.deepEqual(waitOf([lock(minutesAgo(10), 1, 'claude/5-x')]), []);
  const stranger = { author: 'stranger', authorAssociation: 'NONE' };
  assert.deepEqual(waitOf([comment('grade', minutesAgo(30), 1), deferred(minutesAgo(10), 2, 'Waiting for: 7', stranger)]), []);
  assert.deepEqual(waitOf([deferred(minutesAgo(30), 3, 'Waiting for: 7'), comment('report', minutesAgo(10), 2)]), ['7']);
});

// --- PR runs ---

test('PR runs: claude PRs count; fork PRs and non-claude PRs do not; a missing isCrossRepository counts', () => {
  const r = view({
    prs: [
      pr(20, 'claude/7-a'),
      pr(21, 'feature/x'),
      pr(22, 'claude/8-fork', { isCrossRepository: true }),
      { number: 23, headRefName: 'claude/9-b', title: 'PR 23' },
      pr(25, 'claude/10-c', { isCrossRepository: undefined }),
    ],
  });
  assert.deepEqual(r.runs.map((x) => x.key), ['7', '9', '10']);
  assert.deepEqual(r.runs[0], {
    key: '7', issue: 7, pr: 20, branch: 'claude/7-a', title: 'PR 20', body: null, textWithheld: false,
    lockedAt: null, lockId: null, related: false,
  });
});

test('PR runs: claude/x counts as PR-<n> with issue null; a Linear-keyed branch has issue null', () => {
  const r = view({ prs: [pr(24, 'claude/x'), pr(26, 'claude/lin-4-y')] });
  assert.deepEqual(r.runs.map((x) => [x.key, x.issue, x.pr]), [['PR-24', null, 24], ['lin-4', null, 26]]);
});

test('PR runs: claude/pr-12-x and an unparseable branch on PR #12 make two runs', () => {
  const r = view({ prs: [pr(12, 'claude/x'), pr(30, 'claude/pr-12-x')], maxParallel: 5 });
  assert.deepEqual(r.runs.map((x) => [x.key, x.pr]), [['PR-12', 12], ['pr-12', 30]]);
  assert.deepEqual(r.ahead, ['PR-12', 'pr-12']);
});

test('PR runs: only numeric keys collapse; each later PR with the same non-numeric key counts under PR-<n>', () => {
  const r = view({
    prs: [
      pr(52, 'claude/issue-123-20261006-0930'),
      pr(50, 'claude/issue-123-20261006-0900'),
      pr(51, 'claude/issue-123-20261006-0915'),
      pr(61, 'claude/7-b'),
      pr(60, 'claude/7-a'),
    ],
    maxParallel: 9,
  });
  assert.deepEqual(r.runs.map((x) => [x.key, x.pr, x.issue]), [
    ['issue-123', 50, null], ['PR-51', 51, null], ['PR-52', 52, null], ['7', 60, 7],
  ]);
  assert.equal(new Set(r.runs.map((x) => x.key)).size, r.runs.length);
});

test('PR runs: a branch that only contains claude/ further in does not count', () => {
  const r = view({ prs: [pr(20, 'feature/claude/5-x'), pr(21, 'xclaude/6-y'), pr(22, 'Claude/7-z')] });
  assert.deepEqual(r.runs, []);
});

test('PR runs: two PRs with the same key make one run, with the lowest number', () => {
  const r = view({ prs: [pr(31, 'claude/7-second'), pr(30, 'claude/7-first'), pr(32, 'claude/7')] });
  assert.equal(r.runs.length, 1);
  assert.deepEqual([r.runs[0].pr, r.runs[0].branch], [30, 'claude/7-first']);
});

test('PR runs: a fork PR with a lower number does not take the key from this repo\'s PR', () => {
  const r = view({ prs: [pr(20, 'claude/7-fork', { isCrossRepository: true }), pr(21, 'claude/7-own')] });
  assert.deepEqual(r.runs.map((x) => [x.key, x.pr, x.branch]), [['7', 21, 'claude/7-own']]);
});

test('PR runs: a sub-issue of this issue is related', () => {
  const r = view({ prs: [pr(20, 'claude/7-a'), pr(21, 'claude/8-b')], selfIssue: makeIssue(5, { openSubIssues: [7] }) });
  assert.deepEqual(r.runs.map((x) => [x.key, x.related]), [['7', true], ['8', false]]);
});

// --- Lock runs ---

test('lock runs: a PR and a lock with the same key make one run', () => {
  const r = view({ prs: [pr(20, 'claude/7-a')], lockedIssues: [locked(7, minutesAgo(30), 70)] });
  assert.equal(r.runs.length, 1);
  assert.deepEqual(r.runs[0], {
    key: '7', issue: 7, pr: 20, branch: 'claude/7-a', title: 'PR 20', body: null, textWithheld: false,
    lockedAt: minutesAgo(30), lockId: 70, related: false,
  });
});

test('lock runs: the run carries the issue text and the lock branch', () => {
  const r = view({ lockedIssues: [locked(7, minutesAgo(30), 70)] });
  assert.deepEqual(r.runs, [{
    key: '7', issue: 7, pr: null, branch: 'claude/7-x', title: 'Issue 7', body: 'Body of 7', textWithheld: false,
    lockedAt: minutesAgo(30), lockId: 70, related: false,
  }]);
});

test('lock runs: a closed fetched issue, an unlocked one, an entering one and a stale one are ignored', () => {
  const r = view({
    lockedIssues: [
      locked(7, minutesAgo(30), 70, { state: 'closed' }),
      locked(8, minutesAgo(30), 80, { labels: ['claude'] }),
      makeIssue(9, { comments: [lock(minutesAgo(40), 90, 'claude/9-x'), comment('report', minutesAgo(35), 91)] }),
      locked(10, minutesAgo(600), 100),
      locked(11, minutesAgo(30), 110),
    ],
  });
  assert.deepEqual(r.runs.map((x) => x.key), ['11']);
});

test("lock runs: an untrusted author's text is withheld; the pipeline bot's is not", () => {
  const r = view({
    lockedIssues: [
      locked(7, minutesAgo(30), 70, { author: 'stranger', authorAssociation: 'NONE' }),
      locked(8, minutesAgo(20), 80, { author: 'claude[bot]', authorAssociation: 'NONE' }),
      locked(9, minutesAgo(10), 90, { author: 'helper', authorAssociation: 'CONTRIBUTOR' }),
    ],
  });
  assert.deepEqual(r.runs.map((x) => [x.key, x.title, x.body, x.textWithheld]), [
    ['7', null, null, true],
    ['8', 'Issue 8', 'Body of 8', false],
    ['9', null, null, true],
  ]);
});

test('lock runs: a parent and a child of this issue are related', () => {
  const r = view({
    selfIssue: makeIssue(5, { openSubIssues: [6] }),
    lockedIssues: [
      locked(3, minutesAgo(30), 30, { openSubIssues: [5] }),
      locked(6, minutesAgo(20), 60),
      locked(7, minutesAgo(10), 70, { openSubIssues: [8] }),
    ],
  });
  assert.deepEqual(r.runs.map((x) => [x.key, x.related]), [['3', true], ['6', true], ['7', false]]);
});

test('lock runs: a PR run whose locked issue is the parent of this issue is related', () => {
  const r = view({ prs: [pr(20, 'claude/3-a')], lockedIssues: [locked(3, minutesAgo(30), 30, { openSubIssues: [5] })] });
  assert.equal(r.runs[0].related, true);
});

test('self is excluded, whether it comes as a PR or as a locked issue', () => {
  const self = locked(5, minutesAgo(10), 50);
  const r = view({ prs: [pr(20, 'claude/5-self'), pr(21, 'claude/7-a')], lockedIssues: [self, locked(8, minutesAgo(20), 80)], selfIssue: self });
  assert.deepEqual(r.runs.map((x) => x.key), ['7', '8']);
  assert.deepEqual(r.self, { key: '5', lockedAt: minutesAgo(10), lockId: 50 });
});

test('self with two fresh locks after its last release is placed at the first lock', () => {
  const self = makeIssue(5, {
    comments: [
      lock(minutesAgo(170), 40, 'claude/5-old'),
      comment('report', minutesAgo(160), 41),
      lock(minutesAgo(60), 50, 'claude/5-first'),
      lock(minutesAgo(10), 70, 'claude/5-second'),
    ],
  });
  const r = view({ selfIssue: self, lockedIssues: [locked(8, minutesAgo(30), 60)], maxParallel: 1 });
  assert.deepEqual(r.self, { key: '5', lockedAt: minutesAgo(60), lockId: 50 });
  assert.deepEqual([r.ahead, r.admitted], [[], true]);
});

test('self is unlocked (null lockedAt and lockId) when entering, stale or unlabelled', () => {
  const entering = makeIssue(5);
  assert.deepEqual(view({ selfIssue: entering }).self, { key: '5', lockedAt: null, lockId: null });
  assert.deepEqual(view({ selfIssue: locked(5, minutesAgo(600), 50) }).self, { key: '5', lockedAt: null, lockId: null });
  assert.deepEqual(view({ selfIssue: locked(5, minutesAgo(10), 50, { labels: ['claude'] }) }).self, { key: '5', lockedAt: null, lockId: null });
});

// --- Ordering ---

test('ordering: an earlier lock with a larger key is ahead of a later lock with a smaller key', () => {
  const r = view({
    lockedIssues: [locked(3, minutesAgo(20), 400), locked(12, minutesAgo(30), 500)],
    selfIssue: locked(5, minutesAgo(5), 900),
    maxParallel: 5,
  });
  assert.deepEqual(r.runs.map((x) => x.key), ['12', '3']);
  assert.deepEqual(r.ahead, ['12', '3']);
});

test('ordering: at equal times, the lower lockId is ahead even with a larger key', () => {
  const at = minutesAgo(30);
  const r = view({ lockedIssues: [locked(3, at, 500), locked(12, at, 400)], selfIssue: locked(5, at, 450), maxParallel: 5 });
  assert.deepEqual(r.runs.map((x) => x.key), ['12', '3']);
  assert.deepEqual(r.ahead, ['12']);
});

test('ordering: a PR run is always ahead, and PR runs come first by PR number', () => {
  const r = view({
    prs: [pr(41, 'claude/9-b'), pr(40, 'claude/x')],
    lockedIssues: [locked(7, minutesAgo(5), 70)],
    selfIssue: locked(5, minutesAgo(60), 50),
    maxParallel: 5,
  });
  assert.deepEqual(r.runs.map((x) => x.key), ['PR-40', '9', '7']);
  assert.deepEqual(r.ahead, ['PR-40', '9']);
});

test('ordering: two locks with equal lockedAt and lockId are ordered by compareKeys', () => {
  const at = minutesAgo(30);
  const r = view({ lockedIssues: [locked(12, at, 400), locked(3, at, 400), locked(10, at, 400)], selfIssue: makeIssue(5), maxParallel: 5 });
  assert.deepEqual(r.runs.map((x) => x.key), ['3', '10', '12']);
});

test('ordering: when this run is unlocked, every run is ahead', () => {
  const r = view({
    prs: [pr(40, 'claude/9-b')],
    lockedIssues: [locked(7, minutesAgo(5), 70), locked(8, minutesAgo(1), 80)],
    selfIssue: makeIssue(5),
    maxParallel: 5,
  });
  assert.deepEqual(r.ahead, ['9', '7', '8']);
});

test('compareKeys compares digits numerically and other keys as strings', () => {
  assert.ok(compareKeys('9', '10') < 0);
  assert.ok(compareKeys('10', '9') > 0);
  assert.equal(compareKeys('7', '7'), 0);
  assert.ok(compareKeys('abc-10', 'abc-9') < 0);
  assert.ok(compareKeys('10', 'abc-1') < 0);
  assert.ok(compareKeys('pr-3', 'abc-1') > 0);
});

test('admitted is true below maxParallel and false at it', () => {
  const lockedIssues = [locked(7, minutesAgo(30), 70), locked(8, minutesAgo(20), 80)];
  const one = view({ lockedIssues, selfIssue: locked(5, minutesAgo(25), 50), maxParallel: 2 });
  assert.deepEqual([one.ahead, one.admitted, one.maxParallel], [['7'], true, 2]);
  const two = view({ lockedIssues, selfIssue: locked(5, minutesAgo(10), 50), maxParallel: 2 });
  assert.deepEqual([two.ahead, two.admitted], [['7', '8'], false]);
});

// --- Race property ---

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('race property: of runs locking together, exactly the first max(0, min(L, M - P)) are admitted', () => {
  const SEED = 20261006;
  const rand = mulberry32(SEED);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const shuffle = (xs) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

  for (let n = 0; n < 200; n += 1) {
    const L = int(1, 8);
    const P = int(0, 3);
    const M = int(1, 4);
    const keys = shuffle(range(60)).slice(0, L + P);
    const lockIds = shuffle(range(500)).slice(0, L).map((x) => x * 10);
    const runsIn = keys.slice(0, L).map((key, i) => ({
      key: String(key),
      lockId: lockIds[i],
      lockedAt: minutesAgo(int(1, 4) * 7),
      history: int(0, 2),
      againAt: minutesAgo(int(0, 6)),
    }));
    const lockedIssues = runsIn.map((r) => {
      const comments = [lock(r.lockedAt, r.lockId, `claude/${r.key}-x`)];
      if (r.history === 1) comments.unshift(lock(minutesAgo(170), r.lockId - 2, `claude/${r.key}-old`), comment('report', minutesAgo(160), r.lockId - 1));
      // A second fresh lock, later than every run's first lock, so other runs sit between the two.
      if (r.history === 2) comments.push(lock(r.againAt, r.lockId + 5001, `claude/${r.key}-again`));
      return makeIssue(Number(r.key), { comments });
    });
    const prs = keys.slice(L).map((key, j) => pr(700 + j, `claude/${key}-pr`));

    const order = [...runsIn].sort((a, b) => (a.lockedAt < b.lockedAt ? -1 : a.lockedAt > b.lockedAt ? 1 : a.lockId - b.lockId));
    const expected = order.slice(0, Math.max(0, Math.min(L, M - P))).map((r) => r.key).sort();
    const admitted = lockedIssues
      .filter((self) => activeRuns({
        prs, lockedIssues: lockedIssues.filter((i) => i !== self), selfIssue: self, ttlHours: TTL, maxParallel: M, now: NOW,
      }).admitted)
      .map((i) => String(i.number))
      .sort();
    assert.deepEqual(admitted, expected, `seed ${SEED}, case ${n}: L=${L} P=${P} M=${M} runs=${JSON.stringify(runsIn)}`);
  }
});
