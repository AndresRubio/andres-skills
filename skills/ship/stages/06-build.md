# Stage 6: Build

Implement the plan test-first, committing and pushing as you go.

## Inputs

`docs/pipeline/<KEY>/plan.md`, `docs/pipeline/<KEY>/spec.md`, TASKS, BASE_SHA, `$RUN_DIR/checks.txt`, the config's `maxPrSize`.

## Steps

1. **A bug** (the issue has the `bug` label, or the spec's problem is a defect): before task 1, use mattpocock-skills:diagnosing-bugs to build a feedback loop and reproduce the bug as a failing test. Record the reproduction in progress.md.
2. **TASKS ≤ 3:** build here, one task at a time:
   1. Follow superpowers:test-driven-development: write the failing test, watch it fail, write the minimal code, watch it pass.
   2. Run the task's tests and the typecheck from `checks.txt`.
   3. Append "Task N — summary — <sha>" to progress.md's Tasks section.
   4. Commit with the message `<type>(<scope>): <task summary> (#<NUMBER>)` plus the trailer, and push.
3. **TASKS > 3:** use superpowers:subagent-driven-development on plan.md, with these overrides:
   - The worktree already exists: skip its worktree setup.
   - Implementers run on sonnet and reviewers on opus. Name the model every time.
   - After each task its ledger marks complete: copy the ledger (`progress.md` in its SDD workspace) into this issue's progress.md under "## SDD ledger", commit, and push.
   - Its questions for a human are handled as the mode sections below say.
   - When it reaches its final step, don't invoke finishing-a-development-branch. Return here and go on to stage 7.
4. After every task: `node "$PIPELINE" diff-size --base "$BASE_SHA"`. If `files` exceeds `maxPrSize.files` or `lines` exceeds `maxPrSize.lines`, hard rule 9 applies: stop and propose a split of the remaining work.
5. Tick stage 6 and commit it with the last task.

## Outputs

Commits on BRANCH, pushed; progress.md's Tasks (or SDD ledger) section up to date.

## Automatic mode

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
