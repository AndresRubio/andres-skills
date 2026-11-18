# Ready checks token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pipeline-ready` reads a pull request's checks with the workflow's own token, so it works on private repositories, while every other call keeps `PIPELINE_TOKEN`.

**Architecture:** `fetchPr` stops asking for `statusCheckRollup`. A new `fetchPrWithChecks` reads the pull request and its checks in one `gh pr view` call, and `pipeline-ready` makes that call with the token in `ISSUE_PIPELINE_CHECKS_TOKEN`, which its workflow sets to `github.token` and backs with `checks: read` and `statuses: read`.

**Tech Stack:** Node 22 ES modules, `node:test`, the `gh` CLI, GitHub Actions YAML templates.

**Spec:** `plugins/issue-pipeline/docs/superpowers/specs/2026-11-18-ready-checks-token-amendment.md`

## Global Constraints

- All paths below are relative to `plugins/issue-pipeline/`, and every command runs there.
- No new dependencies.
- The variable is named `ISSUE_PIPELINE_CHECKS_TOKEN`. Unset or empty means no separate token: `gh` keeps the authentication it has.
- Every other `gh` call of `pipeline-ready` and the sweep keeps `GH_TOKEN` as it is now.
- Version 0.3.10 in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (`test/version.test.mjs` keeps them equal).
- `npm run check` must pass. The check-gate mod refuses a commit until its own check has passed for the exact tree. A subagent whose commit is refused stops and reports the commit command it was about to run.
- Commits: identity `AndresRubio <2109109+AndresRubio@users.noreply.github.com>`, no attribution lines. Write the message to a file with a unique name in the session scratchpad, check its first line in a Bash call of its own, then run `git commit -F <file>` in a later call, then `git log --oneline -1`.
- Prose in docs, comments and commit messages follows the humanizer rules: no em or en dashes, plain sentences.
- Work on `main`. No push, no tag: those wait for the owner.

## Review Focus

- The checks token reaching other calls. If it were set on `process.env` instead of on one child's environment, every write of `pipeline-ready` would run as `github-actions[bot]` and start no workflow. Pinned by the token-log test in Task 1.
- `ISSUE_PIPELINE_CHECKS_TOKEN` exported but empty, as a local shell can leave it. It must behave as unset, never as `GH_TOKEN=''`. Pinned in Task 1.
- A failed checks read. The pull request must still be reported as `error` and the CLI must exit 1. Pinned by the existing CLI test, whose route moves to the new field list in Task 1.
- The sweep step, which reads no checks, getting the variable by copy and paste. Pinned in Task 2 by counting the variable in the template.
- `ship-status` for a `PR-<n>` key and `verdict-status --post-missing` after the field list changes. Their tests build route keys from `PR_FIELDS`, so they follow the change; Task 1 adds the assertion that `PR_FIELDS` has no `statusCheckRollup`.

---

### Task 1: Read a pull request with its checks through the checks token

**Files:**
- Modify: `skills/ship/scripts/lib/github.mjs` (`ghJson` at line 10, `PR_FIELDS` and `fetchPr` at lines 67 to 72)
- Modify: `skills/ship/scripts/lib/ready-run.mjs` (`realDeps` at line 15)
- Modify: `skills/ship/scripts/lib/commands.mjs` (the `ready` command at line 433)
- Modify: `test/helpers/fake-gh.mjs`
- Test: `test/github.test.mjs`, `test/ready-run.test.mjs`

**Interfaces:**
- Produces:
  - `ghJson(args: string[], { token }: { token?: string } = {}): any`. With `token`, the child `gh` runs with `env: { ...process.env, GH_TOKEN: token }`. Without it, the call is exactly as today.
  - `PR_FIELDS = 'number,url,title,body,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,labels,mergeable,mergeStateStatus,author'`.
  - `PR_CHECKS_FIELDS = \`${PR_FIELDS},statusCheckRollup\``, exported.
  - `fetchPrWithChecks(repo: string, number: number|string, gh = ghJson)`: one call, `gh(['pr', 'view', String(number), '--repo', repo, '--json', PR_CHECKS_FIELDS])`, labels flattened to names as `fetchPr` does. `fetchPr` and `fetchPrWithChecks` share that flattening.
  - `realDeps(repo: string, { checksToken }: { checksToken?: string } = {})`. Its `fetchPr` dependency keeps its name and calls `fetchPrWithChecks` with `(args) => ghJson(args, { token: checksToken })` when `checksToken` is set, else with `ghJson`. Nothing else in `realDeps` changes.
  - `ghTokens(dir: string): string[]` in `test/helpers/fake-gh.mjs`: one entry per call, in call order, holding the `GH_TOKEN` that call saw, `''` when it had none.

- [ ] **Step 1: Write the failing tests**

In `test/github.test.mjs`:

```js
test('fetchPr no longer asks for the checks, and fetchPrWithChecks reads them in the same call', () => {
  assert.doesNotMatch(PR_FIELDS, /statusCheckRollup/);
  assert.equal(PR_CHECKS_FIELDS, `${PR_FIELDS},statusCheckRollup`);
  const seen = [];
  const pr = fetchPrWithChecks('o/r', 7, (args) => { seen.push(args); return { number: 7, labels: [{ name: 'ready' }], statusCheckRollup: [] }; });
  assert.deepEqual(seen, [['pr', 'view', '7', '--repo', 'o/r', '--json', PR_CHECKS_FIELDS]]);
  assert.deepEqual(pr.labels, ['ready']);
  assert.deepEqual(pr.statusCheckRollup, []);
});
```

In `test/ready-run.test.mjs`, import `PR_CHECKS_FIELDS` and `ghTokens`, change the route of the existing test "the CLI prints the result and exits 1 when any PR errored" from `--json ${PR_FIELDS}` to `--json ${PR_CHECKS_FIELDS}` (its assertions stay), and add:

```js
const waitingRoutes = () => ({
  [`pr list --repo ${REPO} --state open --limit 500 --json number,headRefName,isCrossRepository,isDraft`]: [{ number: 7, headRefName: 'pipeline/5-x', isCrossRepository: false, isDraft: false }],
  [`pr view 7 --repo ${REPO} --json ${PR_CHECKS_FIELDS}`]: basePr({ mergeable: 'UNKNOWN', statusCheckRollup: [run('test', 'SUCCESS'), { __typename: 'CheckRun', name: 'pipeline-review', status: 'IN_PROGRESS', conclusion: null }] }),
  [`api --paginate --slurp repos/${REPO}/issues/7/comments`]: [[]],
});

test('the CLI reads each pull request with its checks through ISSUE_PIPELINE_CHECKS_TOKEN, and makes every other call with GH_TOKEN', () => {
  const dir = fakeGh(waitingRoutes());
  const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, ciChecks: ['test'] }) });
  const r = runCli(['ready', '--repo', REPO, '--repo-root', root, '--dry-run'], { env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'pipeline-token', ISSUE_PIPELINE_CHECKS_TOKEN: 'workflow-token' } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json().actions.map((a) => [a.pr, a.action]), [[7, 'wait']]);
  assert.deepEqual(ghTokens(dir), ['pipeline-token', 'workflow-token', 'pipeline-token']);
});

test('without ISSUE_PIPELINE_CHECKS_TOKEN, or with it empty, the pull request read uses GH_TOKEN like every other call', () => {
  for (const checks of [undefined, '']) {
    const dir = fakeGh(waitingRoutes());
    const { root } = makeRepoWithOrigin({ '.claude/pipeline.json': JSON.stringify({ tracker: { type: 'github' }, ciChecks: ['test'] }) });
    const r = runCli(['ready', '--repo', REPO, '--repo-root', root, '--dry-run'], { env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'pipeline-token', ISSUE_PIPELINE_CHECKS_TOKEN: checks } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(ghTokens(dir), ['pipeline-token', 'pipeline-token', 'pipeline-token']);
  }
});
```

`runCli` merges `process.env` with the given env, and Node leaves out a variable whose value is `undefined`, so the first case runs with the variable unset.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/github.test.mjs test/ready-run.test.mjs`
Expected: FAIL, because `PR_CHECKS_FIELDS`, `fetchPrWithChecks` and `ghTokens` are not exported.

- [ ] **Step 3: Record the token in the fake `gh`**

The generated script appends `(process.env.GH_TOKEN ?? '') + '\n'` to `tokens.log` in the same directory as `calls.log`, on every call, routed or not. `ghTokens(dir)` reads it back as `readFileSync(log, 'utf8').split('\n').slice(0, -1)` (an empty token is a real entry, so empty lines are kept), and returns `[]` when the file does not exist.

- [ ] **Step 4: Implement `ghJson`'s token option, the two field lists and `fetchPrWithChecks` in `github.mjs`**

Signatures and values as in the Interfaces block.

- [ ] **Step 5: Wire the token through `realDeps` and the `ready` command**

`realDeps(repo, { checksToken } = {})` as in the Interfaces block. In `commands.mjs`, the `ready` command passes `realDeps(v.repo, { checksToken: process.env.ISSUE_PIPELINE_CHECKS_TOKEN || undefined })` as the second argument of `runReady`, so an empty value counts as unset.

- [ ] **Step 6: Run the two files, then the suite**

Run: `node --test test/github.test.mjs test/ready-run.test.mjs`
Expected: PASS.
Run: `npm test`
Expected: every test passes (734 before this task, 737 after it).

- [ ] **Step 7: Commit**

Files: the four source files and the three test files above. Message first line: `fix(issue-pipeline): read a pull request's checks with their own token in pipeline-ready`.

---

### Task 2: Give `pipeline-ready` the permissions and the token, document it, version 0.3.10

**Files:**
- Modify: `templates/github/pipeline-ready.yml`
- Modify: `README.md` (the `## Workflows` section, line 40)
- Modify: `skills/setup/SKILL.md` (lines 21 and 29)
- Modify: `docs/superpowers/specs/2026-09-24-issue-pipeline-design.md` (lines 424 and 496)
- Modify: `docs/superpowers/specs/2026-11-18-ready-checks-token-amendment.md` (status line)
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Test: `test/workflows.test.mjs`, `test/setup.test.mjs`

**Interfaces:**
- Consumes: the `ready` command reads `ISSUE_PIPELINE_CHECKS_TOKEN` (Task 1).

- [ ] **Step 1: Write the failing tests**

In `test/workflows.test.mjs`:

```js
test('pipeline-ready reads checks with the workflow token: checks and statuses read, ISSUE_PIPELINE_CHECKS_TOKEN only on Decide and act', () => {
  const t = rendered('pipeline-ready.yml');
  assert.match(t, /actions: write\n\s+checks: read\n\s+statuses: read\n/);
  const decide = t.slice(t.indexOf('name: Decide and act'), t.indexOf('name: Sweep deferred'));
  assert.match(decide, /ISSUE_PIPELINE_CHECKS_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(decide, /GH_TOKEN: \$\{\{ secrets\.PIPELINE_TOKEN \|\| github\.token \}\}/);
  assert.equal(t.match(/ISSUE_PIPELINE_CHECKS_TOKEN:/g).length, 1);
});
```

In `test/setup.test.mjs`, add `assert.match(steps, /checks: read/);` to the setup skill test and `assert.match(wf, /checks: read/);` to the README test.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/workflows.test.mjs test/setup.test.mjs`
Expected: FAIL on the three new assertions.

- [ ] **Step 3: Change the template**

In `permissions`, add `checks: read` and `statuses: read` after `actions: write`. In the "Decide and act" step's `env`, add `ISSUE_PIPELINE_CHECKS_TOKEN: ${{ github.token }}` after `GH_TOKEN`, with a comment above it saying that `PIPELINE_TOKEN` is a fine-grained token, those have no Checks permission, and so the read of a pull request with its checks uses this workflow's own token with the two read permissions above. The comment does not repeat the variable name followed by a colon. The sweep step is unchanged.

- [ ] **Step 4: Update the docs**

- `README.md`, after the sentence about `PIPELINE_TOKEN` in `## Workflows`: "A fine-grained token has no Checks permission, so on a private repository it cannot read a pull request's checks. `pipeline-ready` makes that one read with the workflow's own token, which the workflow gives `checks: read` and `statuses: read`, so the owner adds nothing for it."
- `skills/setup/SKILL.md`, at the end of the `PIPELINE_TOKEN` item on line 21, the same fact in one sentence, naming `checks: read`. Line 29 stays as it is unless it then contradicts line 21.
- Design spec line 424: replace "It needs only the default `GITHUB_TOKEN`: it never merges, so the merge token and the deploy-trigger problem are gone." with "It never merges, so the merge token and the deploy-trigger problem are gone. Its writes that must start other workflows (the `pipeline-fix` label, branch updates, the sweep's dispatches) go through `PIPELINE_TOKEN`, with the default token as the fallback. It reads a pull request with its checks through the workflow's own token, with `checks: read` and `statuses: read`, because a fine-grained token has no Checks permission (`2026-11-18-ready-checks-token-amendment.md`)."
- Design spec line 496: replace the item with "`pipeline-ready.yml` has `contents: write` (branch updates), `pull-requests: write` and `issues: write` (labels and comments), `actions: write` (the sweep's dispatches), and `checks: read` and `statuses: read` (the checks of a pull request). It writes with `PIPELINE_TOKEN` and reads a pull request with its checks through the workflow's own token. No merge token exists until a repo opts into Phase 4 auto-merge (D5)."
- Amendment status line: append "Built in 0.3.10 on 2026-11-18, not yet run in Actions."

- [ ] **Step 5: Bump the version to 0.3.10 in the three files**

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: the suite passes (738 tests) and `claude plugin validate . --strict` passes.

- [ ] **Step 7: Commit**

Message first line: `feat(issue-pipeline): version 0.3.10, pipeline-ready reads checks with the workflow token`.

---

### Task 3: Record 2026-11-18 in the handoff

**Files:**
- Modify: `docs/acceptance-handoff.md` (a new section after "Version 0.3.9", before "Conventions this work followed")

This task needs the session's own record, so the controller writes it. Facts to record, all on the private sandbox `AndresRubio/pipeline-sandbox-private` unless said otherwise:

- `main` of andres-skills was pushed with 0.3.9 and tagged `issue-pipeline--v0.3.9` at `b16083f`.
- Pull request 31 pinned the four workflows to `issue-pipeline--v0.3.9` and was merged as `4d95ec2`. The `pipeline-ready` runs it set off passed and started nothing.
- Sub-issues 28, 29 and 30 were closed as not planned.
- Issue 4 was labelled again. Run 44370502112 graded it `fork`: 6 of 6 files, seven assumptions A1 to A7. 0.61 dollars, no denied calls. The split path has still not run on 0.3.9.
- `pipeline-go`, used in Actions for the first time: run 44371321977 resumed issue 4, wrote in "Decisions" that the label accepted A1 to A7, built the change and opened pull request 32, then removed `pipeline-go` and `needs-decision`. 3.02 dollars, 686 seconds, 136 turns, 2 denied calls not identified.
- Review run 44373425878: `accepted`, no findings, 2.27 dollars.
- `pipeline-ready` failed on pull request 32 in runs 44373485709 (after CI), 44373887074 (after the review) and 44378833567 (schedule), each with "GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup...)". Cause and fix: the 0.3.10 amendment. Pull request 32 stays open as its test case.
- Total for the day: 5.90 dollars.
- Still not seen in Actions on 0.3.9: a split, a sub-issue starting from its own label, and whether webhook payloads carry `issue_dependencies_summary`.
- A "Version 0.3.10" part: the change in two sentences, the test count from Task 2, not yet run in Actions, and the next step from the amendment's rollout (move the private sandbox first; expect pull request 32 to be updated, CI and the review to run again, then `ready`).

- [ ] **Step 1: Write the section**
- [ ] **Step 2: Run `npm run check`** and expect it to pass.
- [ ] **Step 3: Commit** with first line `docs(issue-pipeline): record the 0.3.9 sandbox runs and version 0.3.10`.
