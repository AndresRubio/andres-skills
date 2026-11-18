# Ready checks token amendment (2026-11-18)

Amendment to `2026-09-24-issue-pipeline-design.md`, for issue-pipeline 0.3.10. Status: approved by the owner on 2026-11-18, with the calls listed at the end. Built in 0.3.10 on 2026-11-18, not yet run in Actions.

## Why

On 2026-11-18 the private sandbox ran 0.3.9 for the first time. `pipeline-go` resumed issue 4, pull request 32 opened and the review accepted it. `pipeline-ready` then failed three times on that pull request: run 44373485709 after CI, run 44373887074 after the review, and the scheduled run 44378833567:

```
GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup.nodes.0.commit.statusCheckRollup)
```

So no pull request on a private repository can reach `ready`.

The cause is the token. `pipeline-ready` runs the CLI with `GH_TOKEN` set to `PIPELINE_TOKEN`, a fine-grained personal access token, and reads each pull request with `gh pr view --json ...,statusCheckRollup`. GitHub's list of permissions for fine-grained tokens has "Commit statuses" and no "Checks", so such a token can never read the check runs of a private repository. Public repositories serve that read to anyone, which is why the public sandbox never showed it.

Two more readers have the same fault and have not hit it yet. `fetchPr` in `github.mjs` always asks for `statusCheckRollup`, and only `pipeline-ready` uses it:

- `ship-status`, at the end of a fix run keyed `PR-<n>`, reads the pull request only for its branch name (`issueBehindPr`), with the `pipeline-ship` workflow token.
- `verdict-status --post-missing`, when a review ends without a verdict, reads the pull request only for its head SHA, with the `pipeline-review` workflow token.

None of the four workflows asks for `checks: read`, so on a private repository both of those reads would fail as well.

## Goals

- `pipeline-ready` reads a pull request's checks on a private repository and labels it `ready` when everything is green.
- Every other read and write keeps the token it has now. In particular, labels and branch updates that must start other workflows still go through `PIPELINE_TOKEN`.
- `ship-status` and `verdict-status` stop depending on a permission they don't need.

## Non-goals

- The fix stage. It reads `statusCheckRollup` inside the Claude session, with the Claude GitHub App's token, and that app has `checks: write` and `statuses: read`. It has not run on the private sandbox yet; watch it on the first private fix run.
- The Modal runner and its App token.
- Moving every read of `pipeline-ready` and the sweep to the workflow token (approach 2 below).

## Anti-goals

- Widening any token. The owner should not need a classic token or new permissions on `PIPELINE_TOKEN`.
- Hiding a failed read. If the checks read fails, the pull request is still reported as an `error` and the run still fails, as now.

## Approaches

1. The narrow fix, which the owner chose on 2026-11-18. `fetchPr` stops asking for checks. One new read, the pull request together with its checks, goes through the workflow's own token, which `pipeline-ready` gets with `checks: read` and `statuses: read`. Everything else stays on `PIPELINE_TOKEN`. It also clears the two latent failures above.
2. Splitting every read. All reads of `pipeline-ready` and the sweep go through the workflow token, and `PIPELINE_TOKEN` only writes. The rule is easier to state, but it changes every read in both runners and their tests, and gains nothing today, since the fine-grained token reads everything else.
3. Retrying with the other token when GitHub answers "not accessible". Dropped, because it would hide real permission errors.

The owner could also replace `PIPELINE_TOKEN` with a classic token with the `repo` scope. That needs no code, but that token reaches every repository the owner can write to.

## The design

In `github.mjs`, `PR_FIELDS` loses `statusCheckRollup`, so `fetchPr` reads only what its callers use. A new `fetchPrWithChecks(repo, number, gh)` makes the same read plus `statusCheckRollup`, in one `gh pr view` call, so the head SHA and its checks come from the same answer.

The gh wrapper can run one call with a given token: the child `gh` gets `GH_TOKEN` set to it. With no token given, `gh` keeps the authentication it has now (`GH_TOKEN` in Actions, the owner's login locally).

In `ready-run.mjs`, `realDeps(repo, { checksToken })` reads each pull request with `fetchPrWithChecks` through `checksToken`. All other dependencies are unchanged. The `ready` command in `commands.mjs` reads `ISSUE_PIPELINE_CHECKS_TOKEN` from the environment and passes it on. Unset or empty means no separate token, so the local lane and the tests behave as now.

In `templates/github/pipeline-ready.yml`, `permissions` gains `checks: read` and `statuses: read`. The "Decide and act" step sets `ISSUE_PIPELINE_CHECKS_TOKEN: ${{ github.token }}` next to the existing `GH_TOKEN`, with a comment saying why: a fine-grained token has no Checks permission. The sweep step reads no checks and gets nothing new.

When `PIPELINE_TOKEN` is unset, both variables hold `github.token`, which can now read checks, so the fallback works on a private repository too.

## Spec and doc changes

- Design spec §7.1 (line 424) and §7.3 (line 496) still say `pipeline-ready` runs only on the default `GITHUB_TOKEN`, while the template sets `GH_TOKEN` to `PIPELINE_TOKEN` and falls back to `github.token`. Both lines are rewritten: writes that must start workflows use `PIPELINE_TOKEN`, and the pull request read with its checks uses the workflow token with `checks: read` and `statuses: read`.
- `README.md` and `skills/setup/SKILL.md`: one sentence each, saying that a fine-grained token cannot read checks on a private repository and that the workflow's own token makes that read, so the owner adds no permission for it.
- `docs/acceptance-handoff.md`: the 0.3.9 push and tag, the private sandbox's move (pull request 31), sub-issues 28 to 30 closed, issue 4 graded `fork`, `pipeline-go` and pull request 32 with their costs, the three `pipeline-ready` failures, and a "Version 0.3.10" section.
- Version 0.3.10 in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

## Tests

- `fetchPr` no longer asks for `statusCheckRollup`, and `fetchPrWithChecks` asks for it in a single call.
- In `pipeline-ready`, the pull request read runs with the checks token and every other call runs with the ambient token. The fake `gh` in `test/helpers/fake-gh.mjs` records the `GH_TOKEN` each call saw, so a test can check both.
- The `ready` command with `ISSUE_PIPELINE_CHECKS_TOKEN` set, unset and empty.
- `pipeline-ready.yml`: the two new permissions, the new variable on the "Decide and act" step only, and the `GH_TOKEN` line unchanged.
- `ship-status` for a `PR-<n>` key and `verdict-status --post-missing` read the pull request without `statusCheckRollup`.
- Existing tests whose fake routes spell out the old `PR_FIELDS` string are updated to the new one.

## Rollout

1. Build on `main`, `npm run check` green, then push and tag `issue-pipeline--v0.3.10` on the owner's word.
2. Move the private sandbox to 0.3.10 first, since pull request 32 is the test case. That merge moves `main`, so the next `pipeline-ready` finds pull request 32 behind and updates its branch with `PIPELINE_TOKEN`. CI and the review run again (the review cost 2.27 dollars last time), then `pipeline-ready` should label it `ready`. It will be the first branch update on the private sandbox.
3. The public sandbox moves straight from 0.3.8 to 0.3.10 later, in one pull request.

The one fact still unproven is that the workflow token, with `checks: read` and `statuses: read`, reads `statusCheckRollup` through GraphQL on a private repository. GitHub documents both permissions for that token, and step 2 is where it gets proven.

## Calls made in this design

- The variable is named `ISSUE_PIPELINE_CHECKS_TOKEN`, after the one thing it is for.
- The pull request and its checks come from one read, so a push between two reads cannot pair one head with another head's checks.
- Only "Decide and act" gets the variable; the sweep doesn't read checks.
- The private sandbox moves first, against the usual public-first order, because the bug only exists there.
- The handoff record of 2026-11-18 goes into the same work, in one docs commit.

## Left to the builder

- Whether the token goes in as an option to `ghJson` or through a small wrapper made from it.
- How the fake `gh` records `GH_TOKEN` (an extra log line per call, or a second log file).
