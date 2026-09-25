# Stage 3: Grade

Decide whether the issue can be built as it is, needs recorded assumptions, needs a decision, or must be split. The model supplies the facts; the verdict comes from `node "$PIPELINE" grade`.

## Inputs

`$RUN_DIR/issue.json`, `docs/pipeline/<KEY>/research.md`, `$RUN_DIR/config.json`, MODE.

## Steps

1. Read the issue (trusted text only) and research.md. Answers in trusted replies (hard rule 2) count as issue text: a value a reply supplies is not a missing value, and a detail a reply settles is a decision, not an assumption. If the issue has a pipeline `questions` comment followed by trusted replies, copy each answered question and its answer under "## Decisions" when you write grade.md in step 4.
2. Write `$RUN_DIR/checklist.json` with exactly these fields:
   - `estimatedFiles` (integer): files the change will touch, tests included.
   - `estimatedLines` (integer): added plus removed lines, tests included.
   - `estimatedTasks` (integer): plan tasks needed. One task is one test cycle.
   - `independentSubsystems` (boolean): the work contains parts that could ship as separate PRs, each valuable alone.
   - `assumptions` (string array): every detail you must decide that the issue doesn't settle, each one sentence starting "Assume". Details of behaviour the issue asks for are assumptions.
   - `missingValues` (string array): values the change needs that neither the issue nor the repo provides (numbers, names, user-facing text, data). Never turn a missing value into an assumption (hard rule 1).
   - `changesUserVisibleBehaviourNotInIssue` (boolean): true only if the change adds or alters user-visible behaviour the issue doesn't ask for at all.
   - `changesDataModelApiAuthOrDeps` (boolean): it changes the data model, a stored format or schema, a public API, or auth or security, or it adds a dependency.
   - `acceptanceCriteriaDerivable` (boolean): testable acceptance criteria can be written from the issue or from existing tests.
   - `needsWorkflowChanges` (boolean): it needs edits under `.github/workflows/`.
   - `conflictsWithOpenClaudePr` (boolean): research found an open `claude/*` PR touching the same files.
   - `claudeGo` (boolean): true if the issue has the `claude-go` label, or a trusted reply (hard rule 2) posted after the latest pipeline `questions` comment answers every question in it. A partial answer is fine: the regrade forks again with only the unanswered questions.
3. `node "$PIPELINE" grade --checklist-file "$RUN_DIR/checklist.json" --config-file "$RUN_DIR/config.json" --mode "$MODE" > "$RUN_DIR/grade.json"`
4. Write `docs/pipeline/<KEY>/grade.md` from `templates/grade.md`. The verdict line must read exactly `**Verdict:** \`<verdict>\``.
5. Act on the verdict (see the mode sections).

**Questions (for a fork):** one per fork reason and one per missing value. Number them **Q1.**, **Q2.**, …, each followed by "Recommended: <answer> — <why>". For a missing value, write "Recommended: none — please supply the value."

**Proposed split (for too-big):** 2–6 vertical slices in dependency order. Each slice cuts through every layer end to end and is valuable alone. For wide mechanical changes, use expand → migrate → contract slices instead (the tracer-bullet approach from mattpocock/skills to-tickets). Each slice gets a title, a 2–4 line description, acceptance criteria, and an estimated size under `maxPrSize`.

## Outputs

`docs/pipeline/<KEY>/grade.md`, `$RUN_DIR/grade.json`, and the verdict.

## Automatic mode

- **ready or small-gaps:** `tracker:post-comment` kind `grade` with the contents of grade.md. Continue to stage 4.
- **fork:**
  1. Append a "## Questions" section to grade.md.
  2. `tracker:post-comment` kind `questions`, with grade.md plus "Reply to resume, or add `claude-go` to accept the recommendations."
  3. Delete `docs/pipeline/<KEY>` in WT.
  4. Stop procedure (the worktree may be removed; don't post `blocked`).
- **too-big:**
  1. Append a "## Proposed split" section to grade.md.
  2. For each slice in order: `tracker:create-sub-issue` under NUMBER, labelled `claude`, plus `needs-local` if the parent has it.
  3. For every slice after the first: `tracker:add-blocked-by`, blocked by the previous slice.
  4. `tracker:post-comment` kind `split` on the parent, with grade.md and the list of created issues.
  5. `tracker:remove-labels` `claude-working`.
  6. Delete `docs/pipeline/<KEY>` in WT and remove the empty worktree with `node "$PIPELINE" worktree-remove-if-empty --repo-root "$REPO_ROOT" --path "$WT" --branch "$BRANCH" --base "$BASE_REF"`. Stop: the parent stays open until its children finish. This isn't the stop procedure, and no `needs-decision` is added.

## Interactive mode

- **ready or small-gaps:** show grade.md and ask "Proceed with these assumptions?" Write any corrections into grade.md as decisions.
- **fork:** ask the questions one at a time, each with its recommendation. Record the answers under "## Decisions" in grade.md, then continue to stage 4.
- **too-big:** show the proposed split and ask whether to create the sub-issues (then do what automatic mode does, and stop) or to proceed anyway (continue to stage 4).
