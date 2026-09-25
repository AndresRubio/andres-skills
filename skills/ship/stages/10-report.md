# Stage 10: Report

Tell the tracker what happened and release the lock.

## Inputs

PR_URL (or what the user chose instead), grade.md, spec.md, evidence.md, WT.

## Steps

1. `tracker:post-comment` kind `report`, with:
   - The PR link, or what happened instead.
   - The verdict and the numbered assumptions.
   - Evidence highlights: checks passed; screenshots, or "visual check needed"; Known issues.
   - "Merge: review the PR and merge it yourself. The automatic merge gate arrives in Phase 2."
2. `tracker:remove-labels` `claude-working`.
3. Tick stage 10 in progress.md but don't commit it: a commit now would re-run the PR's checks.
4. Leave the worktree in place, because fix runs reuse it. Give its path. After the PR merges, it can be removed with `git worktree remove --force <path>` (stages 9–10 leave uncommitted ticks).

## Outputs

The report comment; the lock released.

## Automatic mode

End with a one-paragraph summary: the issue, the verdict, the PR link, and Known issues.

## Interactive mode

Summarise the same points for the user, including the worktree path.
