# Phase 1 build report: problems found and how they were solved

Branch `phase-1` has 33 commits on top of `main`. Tasks 1–16 of the Phase 1 plan are done and 160 tests pass. Tasks 17–18 (create the sandbox repos, run the acceptance tests) are waiting on the owner.

**How the work was checked:**
- Every task was built by a subagent and reviewed by a separate opus reviewer.
- After all tasks were done, two independent whole-branch reviews ran (opus and fable).
- All their findings went into one fix wave, which got a scoped re-review.
- One small follow-up fixed the last two problems that re-review found.

Most of the problems below were in the plan's own text, not in how it was carried out. Reviews caught each of them before anything touched GitHub.

## 1. Security and trust

| Problem | Where caught | Fix |
|---|---|---|
| Anyone who could comment could forge a lock with a future timestamp and block an issue forever | Task 4 review | Only markers from OWNER, MEMBER, COLLABORATOR or `claude[bot]` count, and lock age comes from GitHub's own `createdAt` |
| The pipeline bot's own markers weren't recognised | Task 6 review | One shared rule, `isPipelineComment`, used by locks, eligibility and the acceptance checker |
| A non-numeric `--open-claude-prs` got around the `maxParallel` limit | Task 6 review | The value is checked; bad input is a usage error |
| Issue titles were pasted into shell commands, so a title containing backticks would run a command | Task 12 review | `branch-name --issue-file`. Titles, bodies, commit messages and the `/ship` argument always go through files, never onto a command line |
| The stage text treated any comment that looked like a marker as the pipeline's own | Final review (opus) | Every comment now carries `pipeline` and `trusted` flags, and the stages act only on those |
| Fork PRs counted toward `maxParallel`, so strangers could exhaust it on a public repo | Final review | Only same-repo PRs count, and a missing field is counted rather than ignored |
| Fix mode worked on fork PRs and ignored the `enabled: false` kill switch | Final review (opus) | Both are refused before the lock is taken |
| A bare `git push` could also push `main` under `push.default=matching` | Final review (fable) | Every push is `git push origin "$BRANCH"`, a test enforces it, and the sandbox gets deny rules for pushes to main, force-push, `gh pr merge` and `reset --hard` |

## 2. CLI defects

| Problem | Fix |
|---|---|
| `config` hid git's real error | The git error is reported; only a genuinely missing file gives "no .claude/pipeline.json" |
| The planned screenshot call deadlocked its own test, and Chrome 153's headless mode never exits after a screenshot | Redesigned as async: start Chrome detached, wait until the file stops growing, then kill the whole process group |
| Screenshots into a folder that didn't exist timed out after 60 s (a reviewer reproduced it) | The folder is created first. Any screenshot failure now becomes "visual check needed" instead of stopping the run |
| The free-port check missed servers bound only to loopback on macOS | It checks the wildcard address, 127.0.0.1 and ::1 |
| Worktree cleanup could delete a branch that had unpushed commits | It refuses unless it is on that exact branch and the branch has no commits of its own |
| A worktree folder deleted by hand broke every resume | `git worktree prune` runs before `worktree add` |
| The PR size check counted the pipeline's own docs (plan.md alone can exceed the limit) | `docs/pipeline/` is excluded |
| An undefined feature ("We should have login.") was graded too-big and split into sub-issues full of guessed values | Missing values now fork before the size check. The spec (§5.2) was updated to match |
| The preview-server start used `set -m`, which aborts zsh (this Mac's shell), and stopping npm left vite running | New CLI commands `preview-start` and `preview-stop` run the server in its own process group. Tested on this Mac with a grandchild server |

## 3. Defects in the agent instructions (stage prose)

| Problem | Fix |
|---|---|
| Shell variables and the working directory don't survive between tool calls | `RUN_DIR/vars.sh` with `set -u` and quote escaping, plus a required `. vars.sh && cd "$WT" &&` prefix. RUN_DIR now lives under `~/.claude-pipeline/runs`, and there is a recipe for rebuilding it after context loss |
| The lock was taken before the eligibility check | Eligibility is checked first; an ineligible issue is left untouched |
| A resumed run reused the old run's MODE, LANE and paths | Only BASE_SHA and TASKS are carried over |
| A reply to a fork couldn't clear it, so the questions looped | A trusted reply that answers every question counts as the decision and is recorded under "Decisions" |
| `claude-go` was never removed, so an issue could loop forever | The stop procedure and a successful finish both remove it; each `claude-go` accepts one set of recommendations |
| A resumed run ignored the owner's reply to a `blocked` comment | Stage 1 reads the reply and applies it |
| `diagnosing-bugs` had no stopping point and would fix the bug outside the plan | It only reproduces the bug; the reproduction becomes the failing test of the plan task that fixes it |
| Fix mode worked on a stale local branch, reviewed only the fix (so every other criterion read as "missing"), couldn't see review comments, and its run cap could never trigger | Fast-forward to the PR branch, review the whole PR from the merge base, read all three kinds of review feedback, and count fix-run locks correctly |
| Interactive runs never posted the `grade` or `assumptions` comments that the spec requires | They are posted in both modes |
| Re-running an issue that already has a PR would fail or create a duplicate | Stage 0 stops with "use --fix", and stage 9 reuses an existing PR |
| Hard rule 7 could strip another run's lock | Before the lock is taken, it just stops. After, it runs the stop procedure, skipping the tracker steps only if the tracker itself failed |
| Stage 2 started research as a background agent, so a headless run could end early | Research runs as a foreground subagent |
| Stage 8 depended on `confession-box`, a skill that exists only on this Mac | Stage 8 has a built-in fallback, and the README lists the skill as optional |

## 4. Test fixtures and the acceptance checker

| Problem | Fix |
|---|---|
| The sandbox kept the default `maxParallel` of 2, so runs 03 and 04 would be refused once 01 and 02 had opened PRs | The sandbox sets `maxParallel` to 6 |
| Fixture 03 (login) would grade too-big, 02 (sort) would drift between ready and fork, and 04 (bilingual) would fork because the Spanish text was missing | Grading order fixed; 02 now leaves one honest gap; 04 supplies every Spanish string |
| The checker could pass a run that skipped the `assumptions` comment, treated any API error as a missing file, and used the same exit code for a crash and a failed fixture | A small-gaps verdict requires an `assumptions` comment; only a 404 counts as missing; exit codes are 0 pass, 1 fail, 2 usage, 3 GitHub error |
| There was no automated check of the prompt-injection fixture (07) | Added to the acceptance set |

## 5. Process and environment

- The API session limit stopped work twice. Work resumed from the build ledger each time, with no rework.
- The `claude` CLI isn't logged in, which blocks the headless acceptance runs. For the same reason the short `/ship` alias is unverified, so use `/claude-pipeline:ship`.
- Each commit's trailer names the model that actually wrote it: Opus 5.5, Sonnet 5 or Haiku 4.5.
- macOS has no `timeout` command, and `claude plugin eval` is early-access, so the plan uses its own acceptance checker.

## Waiting on the owner

1. Log in the CLI (`claude auth login`).
2. Say yes to Task 17, which creates `AndresRubio/pipeline-sandbox` (public) and `pipeline-sandbox-private`.
3. Task 18: automatic runs of fixtures 03, 04, 01, 02 and 07, with 03 first as a cheap permissions check. Then the interactive runs of 01, 02 and 05 together with the owner, the results file, and the v0.1.0 tag.
4. Optional: publish the plugin repo and install the plugin.

## Carried into Phase 2/3

- Make an issue that already has an open PR ineligible in the runners.
- Keep a split parent from coming back into the lane.
- `localOnlyPaths` is not used yet.
- Reuse an existing `claude/<KEY>-*` branch after the issue is renamed.
- Restore the build ledger when a run moves to another machine.
- Declare the plugin's dependencies.
- `maxParallel` versus "nothing merges" in Phase 1.
- Trust for sub-issues created by the bot.
- Cua (trycua/cua) as optional VM isolation for the local runner and for visual checks of desktop apps. Avoid its AGPL parts.
