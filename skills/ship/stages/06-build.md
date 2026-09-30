# Stage 6: Build

Implement the plan test-first, committing and pushing as you go.

## Inputs

`docs/pipeline/<KEY>/plan.md`, `docs/pipeline/<KEY>/spec.md`, TASKS, BASE_SHA, `$RUN_DIR/checks.txt`, the config's `maxPrSize`.

## Steps

1. **A bug** (the issue has the `bug` label, or the spec's problem is a defect): before task 1, use mattpocock-skills:diagnosing-bugs for its first two phases only — build the feedback loop and reproduce the bug as a failing test — then stop the skill: no hypotheses, no fix, no commit. Record the reproduction in progress.md: the test path, the command, and its failing output. That test is the failing test of the plan task that fixes the bug: tell that task's implementer to start from it rather than write a new one. Hypotheses and the fix happen inside that task (diagnosing-bugs' hypothesis, instrument and fix phases; automatic mode: don't stop to show the ranked hypotheses — record them in progress.md instead); never its final cleanup-and-hand-off phase.
2. **TASKS ≤ 3:** build here, one task at a time, skipping any task already listed in progress.md's Tasks section — start after the last one recorded:
   1. For a task that changes behaviour, follow superpowers:test-driven-development, matching stage 5's rule: write the failing test, watch it fail, write the minimal code, watch it pass. Other tasks just do the step.
   2. Run the task's tests, plus the typecheck if `checks.txt` has one.
   3. Write the message `<type>(<scope>): <task summary> (#<NUMBER>)` plus the trailer to `$RUN_DIR/commit-msg.txt` with the file-writing tool (the task summary is free text), commit with `git commit -F "$RUN_DIR/commit-msg.txt"`, and push: `git push origin "$BRANCH"`.
   4. Append "Task N — summary — <sha>" to progress.md's Tasks section. Don't commit this now: it goes in with the next task's commit (the last task's line goes in with the stage-6 tick, step 5). No amend.
3. **TASKS > 3:** use superpowers:subagent-driven-development on plan.md, with these overrides:
   - The worktree already exists: skip its worktree setup.
   - Implementers run on sonnet (opus for fix rounds 4–5) and reviewers on opus. Name the model every time.
   - The plan task that fixes the bug: tell its implementer to start from the reproduction test recorded in progress.md (path, command, failing output), not to write a new one.
   - After each task its ledger marks complete: copy the ledger (`progress.md` in its SDD workspace) into this issue's progress.md under "## SDD ledger" (the file-writing tool, or a command of its own), then commit and push in a separate command: `git add "docs/pipeline/$KEY/progress.md" && git commit -F "$RUN_DIR/commit-msg.txt" && git push origin "$BRANCH"`.
   - Its questions for a human are handled as the mode sections below say.
   - When it reaches its final step, don't invoke finishing-a-development-branch. Return here and go on to stage 7.
4. After every task: `node "$PIPELINE" diff-size --base "$BASE_SHA"`. If `files` exceeds `maxPrSize.files` or `lines` exceeds `maxPrSize.lines`, hard rule 9 applies: stop and propose a split of the remaining work.
5. Tick stage 6 only after the last task's size check (step 4) passes and, on the TASKS > 3 path, after SDD's final whole-branch review. Commit and push it then: `git push origin "$BRANCH"` (on the TASKS ≤ 3 path, together with the last task's progress.md line from step 2.4).

## Outputs

Commits on BRANCH, pushed; progress.md's Tasks (or SDD ledger) section up to date.

## Automatic mode

Diagnosing a bug: don't stop to show the ranked hypotheses from diagnosing-bugs' hypothesis phase — record them in progress.md and continue.

Each of these replaces a question the build skills would ask a human. Each is a stop procedure, asking for the decision shown.

| Situation | Decision asked for in the `blocked` comment |
|---|---|
| SDD's pre-flight finds conflicts between plan tasks or constraints | The conflicts, and which governs |
| A review finding contradicts the plan's text | Both, quoted, and which governs (the plan does **not** win automatically) |
| SDD's round-5 breaker: a load-bearing finding remains | The finding and the attempts so far |
| diagnosing-bugs can't build a feedback loop | What was tried, and how to reproduce |
| Three failed fix hypotheses | The hypotheses tried and their results |
| A value the spec needs is missing (hard rule 1) | Which value |
| The diff passes `maxPrSize` (hard rule 9) | A proposed split of the remaining work |

## Interactive mode

Ask the user in each situation in the table above, then carry on as they decide.
