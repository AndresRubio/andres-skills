# Designing a multi-agent team

## Contents
1. Roster and roles
2. Shared brief header plus role briefs (commitment and trust)
3. Report contract
4. Peer accountability and review (conflict and accountability)
5. Disagreement protocol
6. Integration and the final check (results)
7. Claude Code mechanics that make the structure hold
8. Anti-patterns and fixes
9. Output format and budget

## 1. Roster and roles

Start from the result: **what check proves the whole thing works?** Then pick the fewest roles that get there.

- **Orchestrator** (usually you) leads the subagent team. It owns the team check, the briefs, integration and decisions or escalations, and it is the *backstop* for accountability. Its first team is the user's team: it doesn't defend a subagent's output to the user, it reports the collective outcome.
- **Workers** each own one slice with a clear interface. Split along seams that minimize shared files, and give every file exactly one owner.
- **Reviewer / verifier:** fresh context, independent of the workers. Use one per risky slice, or one for the integrated whole.
- **Optional roles:**
  - a *proposer pair* for a consequential decision: two agents argue different approaches
  - a *red team* for security or data-loss risk
- **Model per role:** mechanical work goes to smaller models. Verification of costly or irreversible decisions goes to the strongest one.

## 2. Shared brief header plus role briefs

Write **one shared header** that every agent gets, then a short role section of **at most 150 words** for each. Commitment comes from clarity: a vague brief produces vague work that nobody can hold to account.

```markdown
## Team goal and team check
<the collective result; the command/measurement that proves it>

## Ground rules
- Report problems with this brief; don't silently work around them.
- "Partial" or "blocked" with honest reasons is a good outcome. A false "done" is the worst outcome.
- Don't weaken tests, skip checks, or touch files you don't own. Ask the orchestrator instead.
- Before reporting, run <integrated check> once, not just your own tests.

## Report back in exactly this format
<section 3>
```

```markdown
## Your part            <slice, owned files>
## Done means           <verifiable check for this slice>
## Out of scope         <what not to touch; who owns adjacent areas>
## Interfaces           <what you consume/produce; names, signatures>
```

## 3. Report contract

This is trust by design: make the honest answer the easy answer.

```markdown
- Status: done | partial | blocked
- Evidence: commands run and their key output
- Not verified / assumptions: …
- Deviations from the brief (and why): …
- Disagreements with the brief: …
- Issues seen in teammates' areas: …
- Changes outside my files: … (or "none")
```

Treat each report as a claim. An empty "not verified" or "deviations" field on non-trivial work is a reason to look harder, not reassurance. Read the disagreement and teammate-issue fields first: that is where buried conflict surfaces.

## 4. Peer accountability and review

Lencioni's level 4 is peers holding peers to the standard. A leader who is the only enforcer is itself a symptom.

- **Consumers check producers.** A worker that depends on another's interface runs its contract tests against the real thing and reports mismatches in "issues seen in teammates' areas".
- **Each worker runs the integrated check** once before reporting, not only its own slice's tests.
- **Reviewer:**
  - fresh context
  - gets the spec, the done-check and the artifact, and sees the worker's self-assessment only after its own pass
  - explicit mandate to find reasons it fails
  - verdict per criterion, with evidence
  - a "fail" actually sends the work back
- **The orchestrator is the backstop.** It re-runs the headline check itself and reads the key diff. Delegating work doesn't delegate accountability for the result.

## 5. Disagreement protocol

When workers, reviewers or proposers disagree:
1. **Surface it.** Put both positions side by side with their evidence. Don't average them into a compromise nobody argued for.
2. **Decide on the evidence,** or escalate to the user if it's a product or preference call that belongs to them.
3. **Record** the decision and the reason in one line, in a file (`decisions.md` or `plan.md`), so it survives `/compact` and `/clear`.
4. **Re-brief** every affected agent. A decision half the team doesn't know about is not a commitment.

## 6. Integration and the final check

- One owner, usually the orchestrator, integrates the work, one branch at a time, and re-runs the team check after each merge.
- The final check runs against the **team** check end to end, and runs the change the way a user would, not only the per-slice tests.
- The final report leads with the collective outcome, then the gaps and risks, then briefly who did what.

## 7. Claude Code mechanics that make the structure hold

Prompts are advice; mechanisms are rules. Prefer:
- **One git worktree per parallel worker**, so two agents never edit the same files.
- **Hooks:** `PreToolUse` to block writes outside a worker's files or to frozen tests; `PostToolUse` to lint after edits; `Stop` / `SubagentStop` to require the check before a report is accepted.
- **A task list** the orchestrator updates, as visible, shared commitments.
- **Plan first:** a `plan.md` the user annotates before any worker starts.

Keep version-specific settings out of the design unless you verified them. Mark them "verify in phase 0" instead (see the verification budget in SKILL.md).

## 8. Anti-patterns and fixes

| Anti-pattern | Dysfunction | Fix |
|---|---|---|
| Subagents always report "done ✅" with no caveats | 1 Confianza | Report contract; welcome "partial" |
| Reviewer shares the worker's context ("please double-check") | 2 Conflicto | Fresh-context reviewer with a mandate to fail |
| "Improve the auth module" as the whole brief | 3 Compromiso | Shared header plus role brief with done-means, out-of-scope, interfaces |
| Orchestrator pastes subagent summaries into its answer | 4 Responsabilidades | Peers verify interfaces; orchestrator re-runs the headline check |
| Each slice passes its own tests, integration never runs | 5 Resultados | Team check, owned end to end |
| Parallel agents editing the same files | 3 / 5 | Worktrees and one owner per file, enforced by a hook |
| Two agents disagree and the orchestrator picks silently | 2 / 3 | Surface, decide, record, re-brief |
| Spawning verifiers to fact-check a design document | budget | Label unverified details; verify only load-bearing claims |

## 9. Output format and budget

Deliver, in at most 1,500 words plus briefs:
1. **Team result and team check** (1–3 lines).
2. **Roster:** a table of role, model, responsibility and owned files.
3. **Shared brief header,** then **role briefs** of at most 150 words each.
4. **Review and verification plan:** who checks what, and what "fail" triggers.
5. **Disagreement protocol:** one short paragraph.
6. **Integration and final check:** the commands or steps, plus the **one runnable mechanism** that makes the team check enforceable. That is the gate script or the hook config, in about 60 lines at most. It is the artifact that stops false "done" reports, so write it out rather than describing it.
7. **Risks:** where this team is most likely to fall into each dysfunction, and the guard against it.

Offer the expanded version (full briefs, remaining scripts, runbook) instead of writing it unprompted.
