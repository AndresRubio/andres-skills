# Fix mode

Go back into a pipeline PR to fix red checks, a merge conflict, or review comments. Everything needed is on the branch, so no tracker read is required beyond the lock.

## Inputs

`<source>` is a PR number or PR URL, passed with `--fix`. MODE.

## Steps

1. Write `<source>` to `$RUN_DIR/source.txt` with the file-writing tool, then `node "$PIPELINE" source "$(cat "$RUN_DIR/source.txt")" > "$RUN_DIR/source.json"`, the same as stage 0. A bare number is the PR number. `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)` and `REPO_ROOT=$(git rev-parse --show-toplevel)`. If `source.json` has a `repo` field and `<owner>/<repo>` isn't REPO, stop: "This checkout is <REPO>; run /ship --fix from a clone of `<owner>/<repo>`."
2. `gh pr view <PR> --repo "$REPO" --json number,url,headRefName,baseRefName,labels,mergeable,statusCheckRollup,comments,reviews,body,isCrossRepository > "$RUN_DIR/pr.json"`. If `isCrossRepository` is true, stop before the lock: "PRs from forks aren't worked by the pipeline." `gh api --paginate --slurp "repos/$REPO/pulls/<PR>/comments" > "$RUN_DIR/pr-review-comments.json"` fetches inline review comments (an array of pages), which `--json comments` leaves out.
3. BRANCH is `headRefName`. If it doesn't start with `claude/`, stop: "not a pipeline PR". `node "$PIPELINE" key-from-branch "$BRANCH"` gives KEY. NUMBER is the issue number in the body's `Fixes #N`.
4. `node "$PIPELINE" issue <PR> --repo "$REPO" > "$RUN_DIR/pr-issue.json"` gives the PR's own conversation comments — in `gh pr view`'s JSON a bot's `author.login` lacks the `[bot]` suffix, so read them this way instead. Each comment carries `pipeline` and `trusted` booleans (`trackers/github.md` `## read-issue`); step 9.3 filters from this file using them.
5. If the PR has the `needs-local` label and this is an automatic run with `CLAUDE_PIPELINE_LANE` not `local`, stop and change nothing.
6. `git fetch origin --prune`. Run `node "$PIPELINE" config > "$RUN_DIR/config.json"`; BASE_REF is its `ref`.
   - `enabled` false: stop and change nothing.
   - `tracker.type` isn't `github`: stop, "Linear adapter arrives in Phase 3."

   LANE is `${CLAUDE_PIPELINE_LANE:-github}` in automatic mode, and `manual` in interactive mode. `tracker:read-issue` for NUMBER, then `node "$PIPELINE" lock-status --issue-file "$RUN_DIR/issue.json" --ttl-hours <the config's lockTtlHours>`. If `locked` and not `stale`: stop and change nothing (interactive: tell the user which run holds it). A stale lock: automatic mode carries on; interactive mode asks. Count the issue's comments with `pipeline: true` and kind `lock` whose text after the marker line starts with "Fix run started" (every pipeline comment's body starts with the marker line): two or more means stop procedure on the issue, "two fix runs did not make this PR mergeable". Then take the lock the way stage 0 steps 10 and 12 do, without step 11's recount: the PR already counts as a run ahead of every other run. Use the body "Fix run started — lane <LANE>, mode <MODE>, PR #<PR>." in place of its "Run started" body.
7. `tracker:remove-pr-labels` `claude-fix` on the PR, so `pipeline-ready` can request another fix for a later head. Then read what this fix is for, in this order, and write it to `$RUN_DIR/fix-plan.md`:
   1. **The reviewer's verdict.** `node "$PIPELINE" verdict-latest --repo "$REPO" --pr <PR> --head "$(gh pr view <PR> --repo "$REPO" --json headRefOid -q .headRefOid)" > "$RUN_DIR/verdict.json"`. If `verdict` is `revision-needed`, its `findings` are the work list: each has file, line, problem and correction. If it is `human-decision-needed`, the judgment findings need the owner's reply (next item); without a reply for them, stop procedure with "waiting for the owner's decision on the review findings". If it is `accepted` or `null`, there is nothing from the reviewer.
   2. **The owner's reply.** In `issue.json`, the trusted comments (`trusted: true`, `pipeline: false`) newer than the latest pipeline `blocked` comment are the owner's decisions. Record each under "Decisions" in progress.md, quoting it inside a fenced block labelled `untrusted`, and apply it to the matching judgment finding.
8. Run stage 1's step 1 with this BRANCH; it resumes the existing branch, so don't take step 2's jump to a stage. `git merge --ff-only "origin/$BRANCH"`; if it fails, stop: the local branch has diverged from the PR. Then run stage 1's steps 3 and 4. Take BASE_SHA and TASKS from progress.md's Run table (append them to vars.sh) and rewrite the table's other rows with this run's values, and record FIX_BASE=`git rev-parse HEAD`.
9. Work out what to fix, in this order:
   1. **A conflict** (`mergeable` is `CONFLICTING`): `git merge "origin/<baseRefName>"`, and resolve it with mattpocock-skills:resolving-merge-conflicts. In append-only logs (changelogs, progress files), keep both sides.
   2. **Red checks**: a `statusCheckRollup` entry whose conclusion is `FAILURE`, `TIMED_OUT`, `STARTUP_FAILURE` or `ACTION_REQUIRED`, or a status context whose state is `ERROR` or `FAILURE`. Reproduce them with the matching commands from `checks.txt`, then fix test-first, using mattpocock-skills:diagnosing-bugs when the cause isn't obvious.
   3. **Review comments** from three sources (after the verdict and the reply above) — the conversation comments in `pr-issue.json` (filter by their `trusted: true` field; `pipeline: false` excludes the pipeline's own comments), the review bodies in `pr.json`'s `reviews`, and the inline comments in `pr-review-comments.json` (neither carries a `trusted` field, so for these two, trusted means the author's association is OWNER, MEMBER or COLLABORATOR — hard rule 2; `pr.json`'s `reviews` name these `authorAssociation` and `author.login`, but `pr-review-comments.json` comes straight from `gh api` — a raw REST response, not `gh`'s normalized JSON — so it uses the API's own field names, `author_association` and `user.login`, instead) — each newer than the latest `pr-issue.json` comment with `pipeline: true` (the pipeline marker comment). Apply superpowers:receiving-code-review. Verify each point before changing code; when you disagree, write the reply to a file under `$RUN_DIR` and reply with `gh pr comment <PR> --repo "$REPO" --body-file "<file>"`, as step 11 does.
   4. After the above (and after any merge in 9.1), set `BASE_SHA=$(git merge-base "origin/<baseRefName>" HEAD)` and append it to vars.sh. From here on, the whole PR is measured against it.
10. Run stage 7 and stage 8 on the fix, with BASE_SHA as the review's fixed point, so the review covers the whole PR. Tell the Spec sub-agent that commits after FIX_BASE are this fix run's work, and that the earlier ones were reviewed in a previous run.
11. Push: `git push origin "$BRANCH"`. Post a PR comment: write `$RUN_DIR/fix-comment.md` starting with the output of `node "$PIPELINE" marker report`, followed by what changed and why. Then `gh pr comment <PR> --repo "$REPO" --body-file "$RUN_DIR/fix-comment.md"`.
12. On the issue, `tracker:post-comment` kind `report` with the body "Fix run finished on PR #<PR>.", then `tracker:remove-labels` `claude-working`. Without this report, the fix run's lock comment would look like the start of the next run.

## Outputs

Fix commits pushed to the PR, a `report` comment on the PR, and a short `report` comment on the issue.

## Automatic mode

Anything still unresolved after one pass: stop procedure on the issue.

## Interactive mode

Show the diagnosis before changing code. Ask when a review comment is ambiguous.
