# Stage 5: Plan

Turn the spec into small, test-first tasks.

## Inputs

`docs/pipeline/<KEY>/spec.md`, `$RUN_DIR/checks.txt`, `$RUN_DIR/config.json`.

## Steps

1. Use superpowers:writing-plans on `docs/pipeline/<KEY>/spec.md`, on model opus, with these overrides (the user's instructions win over the skill's defaults):
   - Save the plan to `docs/pipeline/<KEY>/plan.md`, not `docs/superpowers/plans/`.
   - Skip its "Execution Handoff" question and return here.
   - Its Global Constraints section must include ship's hard rules and the commands in `$RUN_DIR/checks.txt`.
   - Every task that changes behaviour is test-first and names the acceptance criteria (AC…) it satisfies. Every AC is covered by at least one task.
2. `TASKS=$(grep -c '^### Task ' docs/pipeline/<KEY>/plan.md)` and record TASKS in progress.md.
3. If TASKS > 8, the issue is too big after all (see the mode sections).
4. Tick stage 5. Commit and push: `docs(pipeline): plan for #<NUMBER>`.

## Outputs

`docs/pipeline/<KEY>/plan.md` committed and pushed; TASKS.

## Automatic mode

TASKS > 8: stop procedure. The `blocked` comment carries a proposed split written the way stage 3 describes.

## Interactive mode

Give the plan's path and task count and ask "Continue to build?" If the user edits the plan, count the tasks again. TASKS > 8: show a proposed split and ask.
