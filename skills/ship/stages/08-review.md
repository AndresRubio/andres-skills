# Stage 8: Self-review

Review the change against the repo's standards and against the spec, and confess any shortcuts. This is Claude checking its own work; it is not the merge gate.

## Inputs

WT, BASE_SHA (in fix mode, set by `fix.md` step 8), `docs/pipeline/<KEY>/spec.md`, `docs/pipeline/<KEY>/evidence.md`.

## Steps

1. Use mattpocock-skills:code-review with:
   - Fixed point: BASE_SHA.
   - Spec: `docs/pipeline/<KEY>/spec.md`, and the note "The spec is this file; do not look it up in an issue tracker."
   - Both sub-agents on model opus.
2. Use the confession-box skill if it's installed. Otherwise, list yourself every skipped or weakened test, suppressed error or type check, value hardcoded to pass a test, swallowed exception, and `--no-verify` in this run's commits.
3. Classify every finding in evidence.md's Classification table:

   | Finding | Severity |
   |---|---|
   | Spec: an acceptance criterion missing or only partly met | Critical |
   | Spec: another requirement missing or partial | Important |
   | Spec: implemented, but the implementation looks wrong | Critical |
   | Spec: behaviour nobody asked for (scope creep) | Important |
   | Standards: breaks a documented repo standard | Important |
   | Standards: a baseline smell (a judgement call) | Minor |
   | Confession: a skipped or weakened test, a suppressed error or type check, a value hardcoded to pass a test, a swallowed exception, `--no-verify` | Critical |
   | Confession: anything else | Important |

4. **Critical or Important findings:** fix them (test-first where behaviour changes), commit, push (`git push origin "$BRANCH"`), and repeat steps 1–3 on the new commits. At most 2 fix rounds. After a fix, re-run the commands in `checks.txt` and update the Commands table.
5. Write the Standards, Spec and Confession reports (lightly cleaned), the classification and the rounds into evidence.md under "Self-review". Important findings left after round 2 go under "Known issues".
6. Tick stage 8. Commit (`docs(pipeline): self-review for #<NUMBER>`) and push: `git push origin "$BRANCH"`.

## Outputs

evidence.md's Self-review and Known issues sections, committed and pushed.

## Automatic mode

A Critical finding left after 2 rounds: stop procedure, quoting the finding.

## Interactive mode

Show the classification before fixing; the user may re-rate a finding. A Critical finding left after 2 rounds: ask.
