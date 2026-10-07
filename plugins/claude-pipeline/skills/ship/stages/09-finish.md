# Stage 9: Finish

Open the pull request. Never merge it: in Phase 1 the user reviews and merges.

## Inputs

BRANCH, BASE_REF, NUMBER, KEY, REPO, spec.md, evidence.md, `$RUN_DIR/issue.json`.

## Steps

1. `git status --porcelain` must be empty. Commit anything left (with the trailer), then push with `git push -u origin "$BRANCH"` as its own command. Then, as a separate command, record the SHA: `echo "SHA='$(git rev-parse HEAD)'" >> "$RUN_DIR/vars.sh"`.
2. `gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number,url`. If a PR already exists for BRANCH, PR_URL is its `url`: reuse it, skipping only the create step (see the mode sections below).
3. Write the PR body to `$RUN_DIR/pr-body.md`:
   1. The first line is the output of `node "$PIPELINE" marker report`.
   2. `Fixes #<NUMBER>`
   3. **Summary:** the spec's Problem Statement and Solution, in 3 lines or fewer.
   4. **Acceptance criteria:** the ACs as a checklist, ticked where the evidence shows them met.
   5. **Assumptions** (from spec.md) and **Departures from spec** (from evidence.md).
   6. **How it works:** 3–5 lines from spec.md's Implementation Decisions: what changed and why it is shaped that way.
   7. **Alternatives rejected:** from research.md and spec.md, the approaches considered and not taken, one line each, or "None considered."
   8. **Diff risk:** the lines from evidence.md's Diff risk section, or "None."
   9. **Evidence:** the Commands table. Each screenshot as `![<what>](https://github.com/<REPO>/blob/<SHA>/docs/pipeline/<KEY>/screenshots/<file>?raw=true)` (SHA, not the branch, so the link survives a merge), or the "Visual check needed" line.
   10. **Self-review:** finding counts per axis and severity, Known issues, and a one-line confession summary.
   11. "Pipeline files: `docs/pipeline/<KEY>/`"
4. The title is the issue title followed by ` (#<NUMBER>)`, written to `$RUN_DIR/pr-title.txt` with the file-writing tool; that file is what `tracker:create-pr` gets.
5. Labels: `needs-local` if the issue has it, otherwise none.
6. Tick stage 9 in progress.md but don't commit it: a commit now would re-run the PR's checks. A later fix run commits it along with its own changes.

## Outputs

The pull request URL, as PR_URL.

## Automatic mode

If step 2 found an existing PR, reuse it as PR_URL, skip the create call, and continue with the remaining steps (the tick, step 6) and stage 10. Otherwise `tracker:create-pr` with the title, body and labels. Never merge (hard rule 3). Continue to stage 10.

## Interactive mode

Use superpowers:finishing-a-development-branch.
- If the user chooses "Push and create a Pull Request": if step 2 found an existing PR, reuse it as PR_URL and don't create another; otherwise create it with `tracker:create-pr` and the body above.
- If the user chooses to merge locally: follow that skill's steps, but skip its worktree-cleanup step — stage 10 still uses WT and tells the user how to remove it. Stage 10 still reports, with "merged locally" in place of a PR link.
- If the user keeps the branch as-is: go to stage 10 with no PR.
