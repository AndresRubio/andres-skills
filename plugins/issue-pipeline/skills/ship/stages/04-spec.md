# Stage 4: Spec

Write what will be built and how it will be judged. The acceptance criteria written here are the contract the self-review checks.

## Inputs

`$RUN_DIR/issue.json`, `docs/pipeline/<KEY>/research.md`, `docs/pipeline/<KEY>/grade.md` (assumptions and any decisions), and `$RUN_DIR/idea-spec.md` if stage 0 came from free text.

## Steps

1. Write `docs/pipeline/<KEY>/spec.md` from `templates/spec.md`. Draw on the issue (or idea-spec.md) first, then grade.md's decisions, then research.md. Keep it in proportion: a one-line bug gets a short spec.
   - **Acceptance Criteria:** numbered AC1…, each testable and observable, each saying how it's checked. Keep every criterion the issue itself states.
   - **Assumptions:** grade.md's A1… copied exactly, or "None."
   - **Implementation Decisions:** no file paths or code, except a type shape that is itself a decision.
2. Check hard rule 1: every value in the spec (numbers, names, user-facing text, data) must trace to the issue, the repo or a recorded decision.
3. If grade.md lists assumptions: `tracker:post-comment` kind `assumptions` with the numbered list and "These are the assumptions the PR is built on. Reply before merge to correct any." (Interactive mode: this runs once the spec is approved; automatic mode: once it is written.)
4. Tick stages 2–4 in progress.md.
5. Commit and push. This is the first commit on the branch.
   `git add docs/pipeline/<KEY> && git commit -m "docs(pipeline): spec for #<NUMBER>" -m "<trailer>"`
   `git push -u origin "$BRANCH"`

## Outputs

spec.md, research.md, grade.md and progress.md, committed and pushed.

## Automatic mode

A value that fails step 2: stop procedure, naming the value.

## Interactive mode

Show the spec and ask for approval. Revise until the user approves, then commit. A value that fails step 2: ask for it.
