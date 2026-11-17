# Split sub-issue trust (issue-pipeline 0.3.9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sub-issues that a too-big split creates on GitHub run by themselves, one after another, because a sub-issue a pipeline bot wrote is trusted when its trusted parent's split comment lists it.

**Architecture:** A pure parser reads the `Split into:` line from a parent's latest split comment, and a pure `issueTrusted` in `lock.mjs` combines it with the parent's author association. `github.mjs` fetches the parent only for issues a pipeline bot wrote, so the route, the sweep and stage 0 all see the same `parent` field. Stage 3 adds the `pipeline` label to the sub-issues last, after the split comment reads back through a new `split-into` command.

**Tech Stack:** Node 22 ES modules (`.mjs`), `node:test`, the `gh` CLI (faked in tests by `test/helpers/fake-gh.mjs`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-split-sub-issue-trust-amendment.md`, which amends `docs/superpowers/specs/2026-09-24-issue-pipeline-design.md`.

## Global Constraints

- Work from `plugins/issue-pipeline/`, on `main` (the owner's choice), one commit per task. Nothing is pushed or tagged without the owner's word.
- `npm run check` passes before every commit. The pre-commit hook runs it too.
- `TRUSTED` stays `OWNER`, `MEMBER`, `COLLABORATOR`. `PIPELINE_BOTS` stays `claude[bot]`, `github-actions[bot]`.
- The split line is `Split into: ` followed by the sub-issue numbers in slice order joined by `, `, as the comment's last non-empty line, with no backticks, no bold and nothing after it.
- Only the parent's latest pipeline `split` comment (the highest comment id) counts. A parent vouches only through its own author association, so a parent written by a bot never vouches.
- `CODING_STANDARDS.md` applies: a regex on comment text is linear and ships with a 200 KB timing test, and an API path is built only from a validated positive integer and the `--repo` value.
- No em or en dash in any file this plan writes.
- Version `0.3.9` in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
- Commits as `AndresRubio <2109109+AndresRubio@users.noreply.github.com>` with no attribution lines. The message goes in a uniquely named file in the session scratchpad, its first line is checked in a call of its own, then `git commit -F <file>`.

## Review Focus

1. A parent in another repository (`parent_issue_url` outside `REPO`): no parent is fetched and the issue stays untrusted. Test in Task 2.
2. A split line that lists 128 or 280 while the issue is 28: untrusted, because numbers match whole. Test in Task 1.
3. The latest split comment has no line, or leaves the issue out, while an older split comment lists it: untrusted. Test in Task 1.
4. A 200 KB comment of `1, ` repeated with a broken ending: the parser returns `[]` in under a second. Test in Task 1.
5. The GitHub API fails while the route reads the parent: `lane-target` exits non-zero and no ship job starts. The sweep can still start the issue later. Test in Task 4.

## File Structure

- Create `skills/ship/scripts/lib/split.mjs`: the split line (`SPLIT_LINE_RE`, `splitInto`).
- Modify `skills/ship/scripts/lib/lock.mjs`: add `issueTrusted`.
- Modify `skills/ship/scripts/lib/github.mjs`: add `parentNumber` and `fetchSplitParent`. `normalizeIssue` and `fetchIssue` carry `parent`.
- Modify `skills/ship/scripts/lib/eligibility.mjs`: the author check calls `issueTrusted`.
- Modify `skills/ship/scripts/lib/lane.mjs`: trust through `parent`, and refuse an issue blocked by an open issue.
- Modify `skills/ship/scripts/lib/commands.mjs`: `lane-target` fetches the parent, and a new `split-into` command.
- Modify `skills/ship/stages/03-grade.md` and `skills/ship/trackers/github.md`.
- Modify the design spec, the three version files and `docs/acceptance-handoff.md`.
- Tests: create `test/split-trust.test.mjs`. Modify `test/github.test.mjs`, `test/eligibility.test.mjs`, `test/sweep.test.mjs`, `test/lane.test.mjs` and `test/skill-wording.test.mjs`.

---

### Task 1: The split line and the trust rule

**Files:**
- Create: `skills/ship/scripts/lib/split.mjs`
- Modify: `skills/ship/scripts/lib/lock.mjs`
- Test: `test/split-trust.test.mjs` (new)

**Interfaces:**
- Produces: `splitInto(comments: Comment[]): number[]` in `lib/split.mjs`. `Comment` is the normalized comment shape (`id`, `author`, `authorAssociation`, `body`, `marker`). It returns the numbers on the last non-empty line of the latest pipeline `split` comment, in order and without duplicates, or `[]`.
- Produces: `issueTrusted(issue: { number: number, author: string|null, authorAssociation: string, parent?: { number: number, authorAssociation: string, splitInto: number[] } | null }): boolean` in `lib/lock.mjs`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitInto } from '../skills/ship/scripts/lib/split.mjs';
import { issueTrusted } from '../skills/ship/scripts/lib/lock.mjs';

const at = '2026-11-13T22:32:10Z';
const split = (id, line, over = {}) => ({
  id, author: 'claude[bot]', authorAssociation: 'NONE', createdAt: at,
  body: `**[issue-pipeline]** split · ${at} · local\n\n# Grade for 4\n\n${line}\n`,
  marker: { kind: 'split', at, run: 'local' }, ...over,
});

test('splitInto reads the last line of the latest pipeline split comment', () => {
  assert.deepEqual(splitInto([split(1, 'Split into: 28, 29, 30')]), [28, 29, 30]);
  assert.deepEqual(splitInto([split(1, 'Split into: 28,29 ,30  ')]), [28, 29, 30]);
  assert.deepEqual(splitInto([split(1, 'Split into: 28, 28, 29')]), [28, 29]);
  assert.deepEqual(splitInto([split(2, 'Split into: 40'), split(1, 'Split into: 28')]), [40], 'latest by id, not by array order');
  assert.deepEqual(splitInto([split(1, 'Split into: 28'), split(2, 'no line here')]), [], 'the latest split comment decides');
  assert.deepEqual(splitInto([split(1, '`Split into: 28`')]), []);
  assert.deepEqual(splitInto([split(1, 'Split into: 28\n\nThanks')]), [], 'nothing may follow the line');
  assert.deepEqual(splitInto([split(1, 'Split into: 28', { author: 'stranger' })]), [], 'not a pipeline comment');
  assert.deepEqual(splitInto([split(1, 'Split into: 28', { marker: { kind: 'report', at, run: 'local' } })]), []);
  assert.deepEqual(splitInto([]), []);
});

test('splitInto stays linear on a long hostile line', () => {
  const body = `**[issue-pipeline]** split · ${at} · local\n\nSplit into: ${'1, '.repeat(70_000)}x`;
  const start = process.hrtime.bigint();
  assert.deepEqual(splitInto([{ ...split(1, ''), body }]), []);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 1000);
});

const child = (over = {}) => ({
  number: 28, author: 'claude[bot]', authorAssociation: 'NONE',
  parent: { number: 4, authorAssociation: 'OWNER', splitInto: [28, 29, 30] }, ...over,
});

test('issueTrusted: a trusted association, or a pipeline-bot sub-issue that its trusted parent split into', () => {
  assert.equal(issueTrusted({ number: 5, author: 'AndresRubio', authorAssociation: 'OWNER' }), true);
  assert.equal(issueTrusted(child()), true);
  assert.equal(issueTrusted(child({ author: 'github-actions[bot]' })), true);
});

test('issueTrusted refuses any other sub-issue', () => {
  assert.equal(issueTrusted(child({ parent: null })), false);
  assert.equal(issueTrusted(child({ parent: undefined })), false);
  assert.equal(issueTrusted(child({ parent: { number: 4, authorAssociation: 'NONE', splitInto: [28] } })), false, 'a bot-written parent does not vouch');
  assert.equal(issueTrusted(child({ parent: { number: 4, authorAssociation: 'OWNER', splitInto: [] } })), false);
  assert.equal(issueTrusted(child({ parent: { number: 4, authorAssociation: 'OWNER', splitInto: [128, 280] } })), false);
  assert.equal(issueTrusted(child({ author: 'stranger' })), false, 'only a pipeline bot can be vouched for');
  assert.equal(issueTrusted(child({ author: 'other-app[bot]' })), false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/split-trust.test.mjs`
Expected: FAIL, `Cannot find module` for `split.mjs`.

- [ ] **Step 3: Implement `splitInto` in `lib/split.mjs` and `issueTrusted` in `lib/lock.mjs`**

`SPLIT_LINE_RE = /^Split into: (\S.*)$/`. `splitInto` picks the comment with the highest `id` among those where `isPipelineComment(c)` holds and `c.marker?.kind === 'split'`, and takes its last non-empty trimmed line the way `waitingFor` in `runs.mjs` does. It splits the capture on `,`, trims each piece, and returns `[]` unless every piece matches `/^[1-9]\d*$/`. Otherwise it returns the numbers as integers with duplicates dropped. No repeated group sits in the regex, so the scan stays linear. `split.mjs` imports `isPipelineComment` from `lock.mjs`, so `lock.mjs` must not import `split.mjs`. `issueTrusted` is true when `TRUSTED.has(issue.authorAssociation)`, or when `PIPELINE_BOTS.has(issue.author)`, `TRUSTED.has(issue.parent?.authorAssociation)` and `issue.parent.splitInto.includes(issue.number)` all hold.

- [ ] **Step 4: Run them and see them pass**

Run: `node --test test/split-trust.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Check and commit**

Run `npm run check` (expected: all tests pass, `✔ Validation passed`), then commit `test/split-trust.test.mjs`, `skills/ship/scripts/lib/split.mjs` and `skills/ship/scripts/lib/lock.mjs` with the message `feat(issue-pipeline): read the split line and trust a sub-issue its parent split into`.

---

### Task 2: Fetch the parent of a bot-written issue

**Files:**
- Modify: `skills/ship/scripts/lib/github.mjs` (`normalizeIssue`, `fetchIssue`, two new exports)
- Test: `test/github.test.mjs`

**Interfaces:**
- Consumes: `splitInto` (Task 1), `PIPELINE_BOTS` from `lock.mjs`.
- Produces: `parentNumber(repo: string, url: unknown): number | null`. It returns the number when `url` parses with `new URL` as `https:` and its `pathname` is exactly `/repos/<repo>/issues/<n>` with `n` a positive integer and no query or hash. Anything else is null.
- Produces: `fetchSplitParent(repo: string, apiIssue: object, gh = ghJson): { number: number, authorAssociation: string, splitInto: number[] } | null`. It returns null without calling `gh` unless `PIPELINE_BOTS.has(apiIssue.user?.login)` and `parentNumber(repo, apiIssue.parent_issue_url)` is a number. Otherwise it calls `gh(['api', 'repos/<repo>/issues/<n>'])` and `gh(['api', '--paginate', '--slurp', 'repos/<repo>/issues/<n>/comments'])` and returns `{ number: n, authorAssociation: parent.author_association, splitInto: splitInto(normalizeComments(comments.flat())) }`. A `gh` error propagates.
- Produces: `normalizeIssue(apiIssue, apiComments, { blockedBy = [], subIssues = [], parent = null } = {})` returns the fields it returns today plus `parent`. `fetchIssue(repo, number, gh)` passes `parent: fetchSplitParent(repo, issue, gh)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/github.test.mjs`, next to the `waiting-for` tests so `REPO`, `apiIssue`, `issueRoutes` and `loggingGh` are in scope:

```js
const BOT_CHILD = { user: { login: 'claude[bot]' }, author_association: 'NONE', parent_issue_url: `https://api.github.com/repos/${REPO}/issues/4` };
const splitComment = (line) => ({ id: 500, user: { login: 'claude[bot]' }, author_association: 'NONE', created_at: '2026-11-13T22:32:10Z', body: `**[issue-pipeline]** split · 2026-11-13T22:32:10Z · local\n\n${line}` });
const parentRoutes = (line) => ({
  [`api repos/${REPO}/issues/4`]: apiIssue(4, { labels: [{ name: 'pipeline' }] }),
  [`api --paginate --slurp repos/${REPO}/issues/4/comments`]: [[splitComment(line)]],
});

test('parentNumber accepts only an issue of the same repository', () => {
  assert.equal(github.parentNumber(REPO, `https://api.github.com/repos/${REPO}/issues/4`), 4);
  for (const url of [null, undefined, '', 'not a url', 'https://api.github.com/repos/other/r/issues/4',
    `http://api.github.com/repos/${REPO}/issues/4`, `https://api.github.com/repos/${REPO}/issues/4/comments`,
    `https://api.github.com/repos/${REPO}/issues/0`, `https://api.github.com/repos/${REPO}/issues/4?x=1`]) {
    assert.equal(github.parentNumber(REPO, url), null, String(url));
  }
});

test('CLI issue adds the parent of a bot-written sub-issue', () => {
  const { dir } = loggingGh({ ...issueRoutes(28, [], BOT_CHILD), ...parentRoutes('Split into: 28, 29, 30') });
  const r = runCli(['issue', '28', '--repo', REPO], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json().parent, { number: 4, authorAssociation: 'OWNER', splitInto: [28, 29, 30] });
});

test('CLI issue fetches no parent for an owner issue or for a parent in another repository', () => {
  const owner = loggingGh(issueRoutes(5, [], { parent_issue_url: `https://api.github.com/repos/${REPO}/issues/4` }));
  assert.equal(runCli(['issue', '5', '--repo', REPO], { env: { PATH: `${owner.dir}:${process.env.PATH}` } }).json().parent, null);
  assert.ok(!owner.calls().some((c) => c.includes('issues/4')));
  const cross = loggingGh(issueRoutes(28, [], { ...BOT_CHILD, parent_issue_url: 'https://api.github.com/repos/other/r/issues/4' }));
  assert.equal(runCli(['issue', '28', '--repo', REPO], { env: { PATH: `${cross.dir}:${process.env.PATH}` } }).json().parent, null);
  assert.ok(!cross.calls().some((c) => c.includes('other/r')));
});

test('CLI issue fails when the parent of a bot-written sub-issue cannot be read', () => {
  const { dir } = loggingGh({ ...issueRoutes(28, [], BOT_CHILD), [`api repos/${REPO}/issues/4`]: { __ghError: 'HTTP 502' } });
  assert.equal(runCli(['issue', '28', '--repo', REPO], { env: { PATH: `${dir}:${process.env.PATH}` } }).code, 1);
});
```

Existing tests that compare a whole normalized issue gain `parent: null` in their expected value.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/github.test.mjs`
Expected: FAIL, `github.parentNumber is not a function` and `parent` undefined.

- [ ] **Step 3: Implement `parentNumber`, `fetchSplitParent` and the `parent` field in `github.mjs`**

Compare the path against `` `/repos/${repo}/issues/${n}` `` built from the parsed integer, so nothing from the URL reaches the API path unchecked.

- [ ] **Step 4: Run them and see them pass**

Run: `node --test test/github.test.mjs`
Expected: PASS.

- [ ] **Step 5: Check and commit**

`npm run check`, then commit with `feat(issue-pipeline): fetch the parent of a bot-written sub-issue`.

---

### Task 3: Eligibility and the sweep trust a vouched sub-issue

**Files:**
- Modify: `skills/ship/scripts/lib/eligibility.mjs:36`
- Test: `test/eligibility.test.mjs`, `test/sweep.test.mjs`

**Interfaces:**
- Consumes: `issueTrusted` (Task 1) and the `parent` field (Task 2).
- Produces: no new names. `checkEligibility` keeps its reason text `author <author> is not trusted (<association>)`.

- [ ] **Step 1: Write the failing tests**

In `test/eligibility.test.mjs`:

```js
const bot = { author: 'claude[bot]', authorAssociation: 'NONE' };
const vouched = { number: 4, authorAssociation: 'OWNER', splitInto: [5] };

test('a pipeline-bot sub-issue is eligible when its trusted parent split into it', () => {
  assert.equal(check(makeIssue({ ...bot, parent: vouched })).eligible, true);
  assert.match(check(makeIssue({ ...bot, parent: null })).reasons.join(), /author claude\[bot\] is not trusted \(NONE\)/);
  assert.match(check(makeIssue({ ...bot, parent: { ...vouched, splitInto: [6] } })).reasons.join(), /not trusted/);
  assert.match(check(makeIssue({ ...bot, parent: vouched, openBlockedBy: [28] })).reasons.join(), /blocked by #28/);
});
```

In `test/sweep.test.mjs`:

```js
test('a split sub-issue that no run has touched starts once nothing blocks it', () => {
  const child = makeIssue(29, { author: 'claude[bot]', authorAssociation: 'NONE', labeledBy: 'claude[bot]', parent: { number: 4, authorAssociation: 'OWNER', splitInto: [28, 29, 30] } });
  assert.deepEqual(sweepCandidates({ issues: [child], prs: [], closedPrs: [], config, owner: 'AndresRubio', now: NOW }).start, [29]);
  assert.deepEqual(sweepCandidates({ issues: [{ ...child, openBlockedBy: [28] }], prs: [], closedPrs: [], config, owner: 'AndresRubio', now: NOW }).start, []);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/eligibility.test.mjs test/sweep.test.mjs`
Expected: FAIL on the vouched cases (`not trusted`, and `start` is `[]`).

- [ ] **Step 3: Replace `TRUSTED.has(issue.authorAssociation)` with `issueTrusted(issue)` in `checkEligibility`**

Keep `export { TRUSTED }` in `eligibility.mjs`, since other modules import it from there.

- [ ] **Step 4: Run them and see them pass**

Run: `node --test test/eligibility.test.mjs test/sweep.test.mjs`
Expected: PASS.

- [ ] **Step 5: Check and commit**

`npm run check`, then commit with `feat(issue-pipeline): let eligibility and the sweep take a vouched sub-issue`.

---

### Task 4: The route trusts a vouched sub-issue and skips blocked issues

**Files:**
- Modify: `skills/ship/scripts/lib/lane.mjs`, `skills/ship/scripts/lib/commands.mjs` (`lane-target`)
- Test: `test/lane.test.mjs`

**Interfaces:**
- Consumes: `issueTrusted` (Task 1), `fetchSplitParent` (Task 2), `PIPELINE_BOTS`.
- Produces: `laneTarget({ name, payload }, { openPrs = [], parent = null } = {})`. For `issues`/`labeled` and `issue_comment`/`created`, the issue-author check becomes `issueTrusted({ number: issue.number, author: issue.user?.login ?? null, authorAssociation: issue.author_association, parent })` with the reason `issue author is not trusted` kept. Both branches refuse with the reason `issue is blocked by an open issue` when `issue.issue_dependencies_summary?.blocked_by > 0`. The label-sender check stays as it is.
- Produces: `lane-target` passes `parent` when the event is `issues` or `issue_comment`, `PIPELINE_BOTS.has(payload.issue?.user?.login)`, and `payload.issue.number` is a positive integer. It then calls `ghJson(['api', 'repos/<repo>/issues/<number>'])` and passes `fetchSplitParent(repo, thatIssue)`. It reads the parent link from the fresh API issue, never from the payload. A `gh` error propagates, so the command exits 1.

- [ ] **Step 1: Write the failing tests**

```js
const botChild = (over = {}) => issue({ number: 28, author_association: 'NONE', user: { login: 'claude[bot]' }, ...over });
const vouching = { number: 4, authorAssociation: 'OWNER', splitInto: [28, 29, 30] };
const session = { login: 'claude[bot]' };

test('a sub-issue its trusted parent split into starts from its label, from pipeline-go, or from a reply', () => {
  assert.equal(laneTarget({ name: 'issues', payload: labeled('pipeline', botChild(), session) }, { parent: vouching }).run, true);
  assert.equal(laneTarget({ name: 'issues', payload: labeled('pipeline-go', botChild(), owner) }, { parent: vouching }).run, true);
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
```

The existing `CLI lane-target` test, which uses `fakeGh({})` for an owner's issue, keeps passing because an owner's issue causes no fetch.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/lane.test.mjs`
Expected: FAIL, since `run` is false with `issue author is not trusted` and blocked issues still run.

- [ ] **Step 3: Implement the trust input and the blocked refusal in `laneTarget`, and the parent fetch in `lane-target`**

- [ ] **Step 4: Run them and see them pass**

Run: `node --test test/lane.test.mjs`
Expected: PASS.

- [ ] **Step 5: Check and commit**

`npm run check`, then commit with `feat(issue-pipeline): route a vouched sub-issue, and skip events on blocked issues`.

---

### Task 5: The split-into read-back command

**Files:**
- Modify: `skills/ship/scripts/lib/commands.mjs` (a `'split-into'` entry in `COMMANDS`, beside `'waiting-for'`)
- Test: `test/github.test.mjs`

**Interfaces:**
- Consumes: `splitInto` (Task 1), `fetchIssue`, and the existing `issueNumber`, `recountDelayMs` and `sleep` helpers in `commands.mjs`.
- Produces: `node "$PIPELINE" split-into --repo <owner/name> --issue <n> --expect <n>[,<n>…]`. It prints `{"splitInto":[28,29,30]}` when the issue's latest split line lists exactly the expected numbers in the expected order. Otherwise it waits `recountDelayMs()`, fetches once more, and then exits 1 with `{"error":"the posted split doesn't read back: expected 28, 29, 30, got none"}` (or `got 28, 29` when some numbers came back). A missing flag, or an `--expect` entry that is not a positive integer, is a usage error (exit 2).

- [ ] **Step 1: Write the failing tests**

```js
const splitRoutes = (line) => issueRoutes(4, [splitComment(line)], { labels: [{ name: 'pipeline' }] });
const env = (dir) => ({ env: { PATH: `${dir}:${process.env.PATH}`, ISSUE_PIPELINE_RECOUNT_DELAY_MS: '0' } });

test('CLI split-into prints the split when the posted line reads back', () => {
  const { dir, calls } = loggingGh(splitRoutes('Split into: 28, 29, 30'));
  const r = runCli(['split-into', '--repo', REPO, '--issue', '4', '--expect', '28,29,30'], env(dir));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { splitInto: [28, 29, 30] });
  assert.equal(calls().filter((c) => c === `api repos/${REPO}/issues/4`).length, 1);
});

test('CLI split-into exits 1 after one retry when the line is missing, partial or out of order', () => {
  const none = loggingGh(splitRoutes('`Split into: 28, 29, 30`'));
  const r = runCli(['split-into', '--repo', REPO, '--issue', '4', '--expect', '28,29,30'], env(none.dir));
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stderr), { error: "the posted split doesn't read back: expected 28, 29, 30, got none" });
  assert.equal(none.calls().filter((c) => c === `api repos/${REPO}/issues/4`).length, 2);
  const partial = runCli(['split-into', '--repo', REPO, '--issue', '4', '--expect', '28,29,30'], env(loggingGh(splitRoutes('Split into: 28, 29')).dir));
  assert.deepEqual(JSON.parse(partial.stderr), { error: "the posted split doesn't read back: expected 28, 29, 30, got 28, 29" });
  assert.equal(runCli(['split-into', '--repo', REPO, '--issue', '4', '--expect', '29,28'], env(loggingGh(splitRoutes('Split into: 28, 29')).dir)).code, 1);
});

test('CLI split-into: a missing flag or a bad number is a usage error', () => {
  for (const args of [['--repo', REPO, '--issue', '4'], ['--repo', REPO, '--expect', '28'], ['--repo', REPO, '--issue', '4', '--expect', '28,x'], ['--repo', REPO, '--issue', '4', '--expect', '0']]) {
    assert.equal(runCli(['split-into', ...args]).code, 2, args.join(' '));
  }
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/github.test.mjs`
Expected: FAIL, `split-into` is an unknown command.

- [ ] **Step 3: Implement `'split-into'` in `COMMANDS`, following the structure of `'waiting-for'`**

- [ ] **Step 4: Run them and see them pass**

Run: `node --test test/github.test.mjs`
Expected: PASS.

- [ ] **Step 5: Check and commit**

`npm run check`, then commit with `feat(issue-pipeline): add split-into, which reads a posted split line back`.

---

### Task 6: Stage 3 adds the pipeline label to the sub-issues last

**Files:**
- Modify: `skills/ship/stages/03-grade.md` (the automatic-mode `too-big` list)
- Modify: `skills/ship/trackers/github.md` (`## add-labels`)
- Test: `test/skill-wording.test.mjs`

**Interfaces:**
- Consumes: the `split-into` command (Task 5).
- Produces: `tracker:add-labels` takes an optional issue number.

- [ ] **Step 1: Write the failing tests**

```js
test('a too-big split adds pipeline to its sub-issues only after the split comment reads back', () => {
  const tooBig = read('stages/03-grade.md').split('- **too-big:**')[1].split('\n- **wait:**')[0];
  assert.doesNotMatch(tooBig, /create-sub-issue[^\n]*labelled `pipeline`/);
  const order = ['`tracker:create-sub-issue`', '`tracker:add-blocked-by`', 'kind `split`', 'Split into: ',
    'split-into --repo "$REPO" --issue "$NUMBER" --expect', '`tracker:add-labels` `pipeline`', '`tracker:remove-labels` `pipeline-working`']
    .map((s) => tooBig.indexOf(s));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the GitHub tracker adds labels to an issue other than NUMBER when told to', () => {
  assert.match(section(read('trackers/github.md'), 'add-labels'), /gh issue edit "<issue>" --repo "\$REPO" --add-label/);
});
```

Import `section` from `./helpers/skill.mjs` if the file does not already.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/skill-wording.test.mjs`
Expected: FAIL on both.

- [ ] **Step 3: Rewrite the automatic-mode `too-big` list in `03-grade.md` with this text**

```markdown
- **too-big:**
  1. Append a "## Proposed split" section to grade.md.
  2. For each slice in order: `tracker:create-sub-issue` under NUMBER, with `needs-local` if the parent has it and no other label. The `pipeline` label comes in step 6, once the split is on record.
  3. For every slice after the first: `tracker:add-blocked-by`, blocked by the previous slice.
  4. `tracker:post-comment` kind `split` on the parent, with grade.md, the list of created issues and, as the last line, "Split into: " followed by the sub-issue numbers in slice order joined by ", ", such as `Split into: 28, 29, 30`: no backticks, no bold, nothing after it. A sub-issue is trusted only if this line lists it.
  5. Check that the split reads back: `node "$PIPELINE" split-into --repo "$REPO" --issue "$NUMBER" --expect "<numbers>"`, where `<numbers>` is the sub-issue numbers joined by commas, such as `28,29,30`. It fetches the parent, and retries once if the numbers differ. If it fails, apply hard rule 7.
  6. For each sub-issue in order: `tracker:add-labels` `pipeline` on that sub-issue. The first one starts from this label; each later one waits until the one before it is closed.
  7. `tracker:remove-labels` `pipeline-working`.
  8. Delete `docs/pipeline/<KEY>` in WT and remove the empty worktree with `node "$PIPELINE" worktree-remove-if-empty --repo-root "$REPO_ROOT" --path "$WT" --branch "$BRANCH" --base "$BASE_REF"`. Stop: the parent stays open until its children finish. This isn't the stop procedure, and no `needs-decision` is added.
```

- [ ] **Step 4: Rewrite `## add-labels` in `trackers/github.md`**

```markdown
## add-labels

Takes labels, and an issue number when the labels go on an issue other than this run's, as when a split labels its sub-issues. `<issue>` is that number, or `$NUMBER`.

`gh issue edit "<issue>" --repo "$REPO" --add-label "<label>[,<label>…]"`
```

- [ ] **Step 5: Run the wording and structure tests and see them pass**

Run: `node --test test/skill-wording.test.mjs test/skill-structure.test.mjs`
Expected: PASS. The structure test also confirms that `split-into` exists in `COMMANDS` and that `tracker:add-labels` is still defined.

- [ ] **Step 6: Check and commit**

`npm run check`, then commit with `feat(issue-pipeline): add pipeline to split sub-issues after the split reads back`.

---

### Task 7: Spec, version 0.3.9 and the record

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-issue-pipeline-design.md` (§5.2 "On too-big", §6.1 second bullet)
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Modify: `docs/acceptance-handoff.md`
- Test: `test/version.test.mjs` (existing)

- [ ] **Step 1: Edit §5.2 "On too-big" of the design spec**

Replace its first bullet with: "Create sub-issues without the `pipeline` label, chained in order with blocked-by links." Replace the second with: "Comment the split on the parent, ending with a `Split into: <numbers>` line, and check that it reads back. Then add `pipeline` to each sub-issue in order. The parent stays open, blocked by its children (see `2026-11-15-split-sub-issue-trust-amendment.md`)."

- [ ] **Step 2: Edit the second bullet of §6.1**

"It was created by you or a collaborator (GitHub `author_association` of OWNER, MEMBER or COLLABORATOR; in Linear, a workspace member), or it is a sub-issue that a pipeline bot created in a split: its parent was created by you or a collaborator, and the parent's latest `split` comment lists it on its `Split into:` line (`2026-11-15-split-sub-issue-trust-amendment.md`)."

- [ ] **Step 3: Set the version to 0.3.9 in the three files and run the version test**

Run: `node --test test/version.test.mjs`
Expected: PASS.

- [ ] **Step 4: Add two sections to `docs/acceptance-handoff.md`, before "## Conventions this work followed"**

"## The first split, 2026-11-13" records the run on the private sandbox. The owner said yes to labelling issue 4 ("Make the whole app bilingual"). Ship run 43519533724 took 202 seconds, 40 turns and 0.66 dollars, with no denied tool calls. The grade was `too-big` (8 files against a limit of 6, and parts that could ship apart), with seven assumptions. It created sub-issues 28, 29 and 30, chained them and posted the split comment. The route skipped all three label events with "issue author is not trusted" (runs 43520027166, 43520038246, 43520052542), because GitHub gives `claude[bot]` the author association `NONE`. The private canary string was found in no issue, comment or branch history of the public sandbox. The history search was confirmed by running it on the private repository, where it finds the string once. `pipeline-go` stayed untested.

"## Version 0.3.9" lists the four changes (the trust rule, the parent fetch, the new order in stage 3 with `split-into`, and the route's refusal of blocked issues), the test count and `npm run check` passing. It also lists what has not run in Actions yet: a split on 0.3.9, a sub-issue starting from its label, a later sub-issue starting after a merge, and `pipeline-go`. It adds that sub-issues 28 to 30 stay untrusted on 0.3.9 because their split comment has no `Split into:` line. Last, it gives the rollout steps from the amendment, each at the owner's word, and says that the tag `issue-pipeline--v0.3.9` and the push wait for the owner.

- [ ] **Step 5: Mark the amendment as built**

In the amendment's status line, add "Built in 0.3.9 on <the commit's date>, not yet run in Actions.", with the date written out as YYYY-MM-DD.

- [ ] **Step 6: Check and commit**

Run `npm run check` and expect every test to pass and `✔ Validation passed`. Then commit the spec, the amendment, the three version files and the handoff with `feat(issue-pipeline): version 0.3.9, split sub-issues that can run`.

---

## After the plan

Tagging `issue-pipeline--v0.3.9`, pushing `main`, and moving each sandbox to 0.3.9 through the setup command all wait for the owner's word, one step at a time, as in 0.3.8.
