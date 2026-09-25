# Fix mode

Go back into a pipeline PR to fix red checks, a merge conflict, or review comments. Everything needed is on the branch, so no tracker read is required beyond the lock.

## Inputs

`<source>` is a PR number or PR URL, passed with `--fix`. MODE.

## Steps

1. `node "$PIPELINE" source "<source>"`. A bare number is the PR number. `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)` and `REPO_ROOT=$(git rev-parse --show-toplevel)`.
2. `gh pr view <PR> --repo "$REPO" --json number,url,headRefName,baseRefName,labels,mergeable,statusCheckRollup,comments,body > "$RUN_DIR/pr.json"`
3. BRANCH is `headRefName`. If it doesn't start with `claude/`, stop: "not a pipeline PR". `node "$PIPELINE" key-from-branch "$BRANCH"` gives KEY. NUMBER is the issue number in the body's `Fixes #N`.
4. Count earlier fix runs: the PR comments whose first line is a pipeline marker of kind `report`, posted by a trusted author (`authorAssociation` OWNER, MEMBER or COLLABORATOR, or `claude[bot]`) — `gh pr view --json comments` gives each comment's `author.login` and `authorAssociation`. Two or more: stop procedure on the issue, "two fix runs did not make this PR mergeable".
5. If the PR has the `needs-local` label and this is an automatic run with `CLAUDE_PIPELINE_LANE` not `local`, stop and change nothing.
6. `git fetch origin --prune`. Run `node "$PIPELINE" config > "$RUN_DIR/config.json"`; BASE_REF is its `ref`. `tracker:read-issue` for NUMBER, then `node "$PIPELINE" lock-status --issue-file "$RUN_DIR/issue.json" --ttl-hours <the config's lockTtlHours>`. If `locked` and not `stale`: stop and change nothing (interactive: tell the user which run holds it). A stale lock: automatic mode carries on; interactive mode asks. Then take the lock the way stage 0 step 9 does.
7. Run stage 1's steps 1, 3 and 4 with this BRANCH. Step 1 resumes the existing branch; don't take step 2's jump to a stage. Take BASE_SHA and TASKS from progress.md's Run table (append them to vars.sh) and rewrite the table's other rows with this run's values, and record FIX_BASE=`git rev-parse HEAD`.
8. Work out what to fix, in this order:
   1. **A conflict** (`mergeable` is `CONFLICTING`): `git merge "origin/<baseRefName>"`, and resolve it with mattpocock-skills:resolving-merge-conflicts. In append-only logs (changelogs, progress files), keep both sides.
   2. **Red checks** (entries in `statusCheckRollup` with conclusion `FAILURE`): reproduce them with the matching commands from `checks.txt`, then fix test-first, using mattpocock-skills:diagnosing-bugs when the cause isn't obvious.
   3. **Review comments** from trusted authors, newer than the last pipeline marker comment from such an author: apply superpowers:receiving-code-review. Verify each point before changing code, and reply on the PR with your reasoning when you disagree.
9. Run stage 7 and stage 8 on the fix, with FIX_BASE as the review's fixed point.
10. Push. Post a PR comment: write `$RUN_DIR/fix-comment.md` starting with the output of `node "$PIPELINE" marker report`, followed by what changed and why. Then `gh pr comment <PR> --repo "$REPO" --body-file "$RUN_DIR/fix-comment.md"`.
11. `tracker:remove-labels` `claude-working` on the issue.

## Outputs

Fix commits pushed to the PR, and a `report` comment on the PR.

## Automatic mode

Anything still unresolved after one pass: stop procedure on the issue.

## Interactive mode

Show the diagnosis before changing code. Ask when a review comment is ambiguous.
