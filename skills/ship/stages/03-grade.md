# Stage 3: Grade

Decide whether the issue can be built as it is, needs recorded assumptions, needs a decision, or must be split. The model supplies the facts; the verdict comes from `node "$PIPELINE" grade`.

## Inputs

`$RUN_DIR/issue.json`, `docs/pipeline/<KEY>/research.md`, `$RUN_DIR/config.json`, `$RUN_DIR/active-runs.json`, MODE.

## Steps

1. Read the issue (trusted text only) and research.md. Answers in trusted replies (hard rule 2) count as issue text: a value a reply supplies is not a missing value, and a detail a reply settles is a decision, not an assumption. If the issue has a comment with `pipeline: true` and kind `questions` (the latest one) followed by trusted replies — comments with `trusted: true` and `pipeline: false` — copy each answered question and its answer under "## Decisions" when you write grade.md in step 5.
2. Refresh the count of runs in progress: `tracker:active-runs` with `--expect-locked`, overwriting `active-runs.json`. If it fails, apply hard rule 7.
3. Write `$RUN_DIR/checklist.json` with exactly these fields:
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
   - `waitFor` (string array): the keys of the runs that research.md's In-flight overlap marks `builds-on`, `same-code` or `same-decision`. Copy each key as research.md names it, which is the key `active-runs.json` used at stage 0, such as `12` (never `#12`).
   - `waitOverride` (boolean): true if the issue has the `claude-go` label, or after the user chose to go ahead alongside those runs on a `wait` grade in interactive mode (see "The wait question" under Interactive mode). A reply never sets it.
   - `claudeGo` (boolean): true if the issue has the `claude-go` label, or a trusted reply (a comment with `trusted: true` and `pipeline: false`) posted after the latest comment with `pipeline: true` and kind `questions` answers every question in it. A partial answer is fine: the regrade forks again with only the unanswered questions.
4. `node "$PIPELINE" grade --checklist-file "$RUN_DIR/checklist.json" --config-file "$RUN_DIR/config.json" --mode "$MODE" --active-runs-file "$RUN_DIR/active-runs.json" > "$RUN_DIR/grade.json"`
5. Write `docs/pipeline/<KEY>/grade.md` from `templates/grade.md`. The verdict line must read exactly `**Verdict:** \`<verdict>\``. Write any `notes` from grade.json into "Why". A `went ahead alongside` note also goes under "## Decisions" as "Went ahead alongside <labels>: <who>", where <who> is "the `claude-go` label" or "you" (the user, in interactive mode; grade.md speaks to the owner).
6. Act on the verdict (see the mode sections).

**Questions (for a fork):** one per fork reason and one per missing value. Number them **Q1.**, **Q2.**, …, each followed by "Recommended: <answer> — <why>". For a missing value, write "Recommended: none — please supply the value."

**Proposed split (for too-big):** 2–6 vertical slices in dependency order. Each slice cuts through every layer end to end and is valuable alone. For wide mechanical changes, use expand → migrate → contract slices instead (the tracer-bullet approach from mattpocock/skills to-tickets). Each slice gets a title, a 2–4 line description, acceptance criteria, and an estimated size under `maxPrSize`.

## Outputs

`docs/pipeline/<KEY>/grade.md`, `$RUN_DIR/grade.json`, and the verdict.

## Automatic mode

- **ready or small-gaps:** `tracker:post-comment` kind `grade` with the contents of grade.md. Continue to stage 4.
- **fork:**
  1. Append a "## Questions" section to grade.md.
  2. `tracker:post-comment` kind `questions`, with grade.md plus a closing line: if every question is about a missing value, "Reply with the values to resume." (a `claude-go` can't supply a value) — otherwise "Reply to resume, or add `claude-go` to accept the recommendations; it also lets this issue run alongside runs in progress."
  3. Delete `docs/pipeline/<KEY>` in WT.
  4. Stop procedure (the worktree may be removed; don't post `blocked`).
- **too-big:**
  1. Append a "## Proposed split" section to grade.md.
  2. For each slice in order: `tracker:create-sub-issue` under NUMBER, labelled `claude`, plus `needs-local` if the parent has it.
  3. For every slice after the first: `tracker:add-blocked-by`, blocked by the previous slice.
  4. `tracker:post-comment` kind `split` on the parent, with grade.md and the list of created issues.
  5. `tracker:remove-labels` `claude-working`.
  6. Delete `docs/pipeline/<KEY>` in WT and remove the empty worktree with `node "$PIPELINE" worktree-remove-if-empty --repo-root "$REPO_ROOT" --path "$WT" --branch "$BRANCH" --base "$BASE_REF"`. Stop: the parent stays open until its children finish. This isn't the stop procedure, and no `needs-decision` is added.
- **wait:**
  1. Append a "## Waiting for" section to grade.md: each run in grade.json's `waitFor`, its relation and the evidence from research.md.
  2. `tracker:post-comment` kind `deferred`. The body is grade.md, then "This issue becomes eligible again once none of these runs is in progress: the sweep or the next poll picks it up, or run `/ship #<NUMBER>` again. To run it alongside them anyway, add `claude-go`.", then, as the last line, grade.json's `waitLine` copied verbatim: no backticks, no bold, nothing after it.
  3. Check that the wait reads back: `node "$PIPELINE" waiting-for --repo "$REPO" --issue "$NUMBER" --expect "<keys>"`, where `<keys>` is grade.json's `waitFor` joined by commas, such as `7,12`. It fetches the issue, and retries once if the keys differ. If it fails, apply hard rule 7.
  4. `tracker:remove-labels` `claude-working`.
  5. Delete `docs/pipeline/<KEY>` in WT and remove the empty worktree, as too-big does.
  6. `rm -rf "$RUN_DIR"`, as stage 10 does.
  7. Stop. This isn't the stop procedure: no `needs-decision` is added. Eligibility holds the issue back until none of those runs is in progress.

## Interactive mode

- **ready or small-gaps:** show grade.md and ask "Proceed with these assumptions?" Write any corrections into grade.md as decisions, then `tracker:post-comment` kind `grade` with grade.md.
- **fork:** if grade.json has `waitFor`, ask the wait question (below) first, before any fork question. If the user goes ahead, or there is no `waitFor`: ask the questions one at a time, each with its recommendation. Record the answers under "## Decisions" in grade.md, then `tracker:post-comment` kind `grade` with grade.md, and continue to stage 4.
- **too-big:** if grade.json has `waitFor`, ask the wait question (below) first, before the split choice. If the user goes ahead, or there is no `waitFor`: show the proposed split and ask whether to create the sub-issues (then do what automatic mode does, which includes the `split` comment, and stop) or to proceed anyway (`tracker:post-comment` kind `grade` with grade.md, then continue to stage 4).
- **wait:** ask the wait question (below).

**The wait question.** Show each run in grade.json's `waitFor`, with its relation and evidence from research.md's In-flight overlap, and ask: "Wait for <labels> (posts `deferred` and stops), or go ahead alongside?" A label is `#<n>` for each key in grade.json's `waitFor`.
- **On wait:** on a fork or too-big grade, first rewrite grade.md as a wait: its Verdict line becomes `**Verdict:** \`wait\``, and "Why" gets one line per run in `waitFor`, "overlaps <label>, a run ahead of this one", plus one line "Also found: <the fork or too-big reasons>. These are asked when the issue can start." in place of those reasons. This is the one case where grade.md's verdict differs from grade.json's. Then follow the automatic **wait** steps with grade.json's `waitFor` and `waitLine`: their step 1 adds "## Waiting for", the only place it is added, and step 2 posts the `deferred`. Ask no fork question and make no split choice, so no answer is given and then lost.
- **On go ahead:** on a `wait` grade, set `waitOverride` to true in `checklist.json`, run the grade command (step 4) again, write grade.md again with that verdict, and act on it as this section says; its `went ahead alongside` note goes under "## Decisions" (step 5). On a fork or too-big grade, record "Went ahead alongside <labels>: you" under "## Decisions" (grade.md speaks to the owner), then carry on with the fork questions or the split choice.
