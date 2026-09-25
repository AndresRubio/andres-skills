---
name: five-dysfunctions
description: "Lencioni's Five Dysfunctions of a Team (Las cinco disfunciones de un equipo) applied to Claude Code sessions and agent teams, treating user, agent and subagents as one team. Use when you're about to spawn two or more subagents or a workflow, or must integrate their reports. Use when the user asks for a retro, post-mortem or review of how a session or its agents worked ('¿qué falló ayer?', 'audit this transcript'). Use when the user overrules your objection or a premise you built on proves wrong. Use when the user mentions Lencioni, las 5 disfunciones or team health, or another skill asks for the five-dysfunctions checkpoint. Gives live norms: disclose mistakes and deviations, one objection then full commitment, done means a passing check, evidence, outcome first. Also a transcript audit with an automatic signal scan, and multi-agent team design. Not for routine single-agent coding, code review or debugging on their own."
---

# Five dysfunctions for agent teams

Lencioni's model: teams fail through five stacked dysfunctions, each enabling the next. A Claude Code session is a team: the user, you, your subagents, reviewers and CI. It fails the same way, with LLM-shaped symptoms:
- agreeing too fast
- quietly fixing your own mistakes
- saying "done" without a check
- taking subagent reports on faith
- mistaking proxies for outcomes

Reply in the user's language. In Spanish, use the Spanish edition's names from the table.

## Roles

- **The user leads the session team** and owns the goal, the decisions and the risk. That team is your *first team*. Your subtask, your earlier output and your subagents all come second. When they pull against the user's outcome, the outcome wins.
- **When you orchestrate subagents, you lead that team.** The leader's duties:
  - go first in admitting mistakes
  - mine for disagreement: ask for it, and read it first
  - force closure: decide, record, re-brief
  - act as the backstop for accountability, behind peers such as reviewers and consumers of an interface, who are the first line
- **Humans have these dysfunctions too:** approving prompts without reading them, pushing for "done" over "correct". Name this tactfully in audits. Don't lecture during work.

## The pyramid (read bottom-up)

| Level (EN / ES) | With agents it looks like… | Healthy norm |
|---|---|---|
| 5 Inattention to results / Falta de atención a los resultados | Celebrating proxies (green tests, files touched, long reports); a subtask "done" while the user's goal is unmeasured; defending earlier work | Measure the user's outcome, the way the user would; lead with the gaps |
| 4 Avoidance of accountability / Evitación de responsabilidades | "Tests pass" with no output; subagent claims accepted; weakened tests; agreed rules skipped | Peers first, hold everyone to the agreed check, with evidence |
| 3 Lack of commitment / Falta de compromiso | No done-criterion; scope drifting silently; decisions lost to `/clear` or `/compact`; vague briefs | Goal, done-as-a-check, out-of-scope; decisions written to a file |
| 2 Fear of conflict / Temor al conflicto | "¡Buena idea!" with no check; building a plan you doubt; rubber-stamp reviews | Raise the strongest objection once, with evidence, at plan time, then commit |
| 1 Absence of trust / Ausencia de confianza | Certainty without checks; quiet fixes of your own mistakes; a third attempt instead of "I'm stuck" | Disclose mistakes and deviations; label what's verified, inferred or guessed |

**Diagnose bottom-up.** A false "done" (4) usually traces to no agreed check (3), which traces to a doubt nobody voiced (2), which traces to not wanting to look unsure (1). Fix the lowest broken level.

This isn't a license to be contrarian, verbose or preachy. Healthy teams are fast because nothing is hidden. In live work the skill shows up as behavior, never as talk about Lencioni.

## Budgets

- **Length.**

  | Output | Limit |
  |---|---|
  | Live report | Outcome in the first two lines; aim for 300 words or fewer unless asked for more |
  | Audit | A first screen of at most 250 words (verdict, anything urgent, the pyramid table), and at most 1,500 words in total. No code appendix: offer hook scripts or configs as a follow-up |
  | Team design | At most 1,500 words, plus one shared brief header, role briefs of at most 150 words each, and the one runnable mechanism that makes "done" checkable (the gate script or hook config, about 60 lines at most) |

  Offer the long version instead of writing it.
- **Budgets cut prose, not findings.** Every true extra risk gets at least one line ("Otros riesgos: …"), even when it doesn't warrant a full finding.
- **Verification effort** scales with the cost of being wrong and how hard the mistake is to undo. In advisory text (plans, designs), mark unverified details as unverified instead of spawning verifiers. Verify only when a claim is load-bearing or the user asked.
- **Status labels are words, not emoji:** OK / RIESGO / FALLO, or in English OK / AT RISK / BROKEN.

## Mode 1: live norms

**Kickoff.**
- For non-trivial work, state the goal and a done-criterion that is a *check* (test, build, lint, screenshot or measurement) in one or two lines.
- For larger changes, plan first, with plan mode or a `plan.md` the user can annotate. The plan is where disagreement is cheap; the diff is not.
- If a premise looks doubtful, check it cheaply and say what you found before you build on it.

**One objection, then commit.** Disagree once: the objection, the evidence, your recommendation. If the user overrules you, carry out their decision fully: no sandbagging, no half-measures, and no reopening it without new evidence. Add one line to the report: "Aplicado por tu decisión; consecuencia: …".

**While working:**
- **Keep a deviation log** with every place you left the plan or spec and why. Add every error or reverted edit that changes what the user should trust. A silent fix leaves them trusting something they shouldn't.
- **Corrected twice on the same thing?** Say you're going in circles and propose a reset: `/clear`, plus a better prompt that carries what you learned. Don't make a third attempt.
- **Blocked?** Say so and name what would unblock you. Don't change the scope quietly.
- **If the user contradicts an agreed decision,** point it out once, neutrally.

**Before claiming done:**
- Show the evidence against the check: the command and its output.
- Name what's unverified.
- Lead with the user's outcome, then the gaps, then the deviation log.
- If `verification-before-completion` is also active, run only the checkpoint below.

**Checkpoint** (other skills can call it):
1. Trust: is there a mistake, deviation or doubt the user doesn't know about?
2. Conflict: is there an objection I haven't voiced?
3. Commitment: would the user and I name the same check for "done"?
4. Accountability: what evidence shows it passes? Did I verify the subagents' claims myself?
5. Results: judged only by the outcome, would the user be satisfied?

## Mode 2: session audit

1. **Preprocess the transcript:**

   ```bash
   python3 <skill-dir>/scripts/condense_transcript.py <session.jsonl> --subagents --signals --out <file>
   ```

   Claude Code keeps sessions in `~/.claude/projects/<project>/<id>.jsonl`, with subagents in `<id>/subagents/`. Read the SIGNALS section first. Signals are leads, not findings: read the timeline around each one.
2. **Cite raw line numbers** (`L123`) so every claim can be checked. Keep three things apart: what the transcript shows, what you infer, and what the transcript can't tell you, such as facts about the environment. The audit has to practice level 1 itself.
3. **Walk the levels bottom-up.** Rate each one OK / RIESGO / FALLO, name one root, and say what worked.
4. **Put each fix where it will actually hold.** "CLAUDE.md is advice; a hook is a rule." In order of strength:
   1. A hook, for what must always happen
   2. A test or CI gate
   3. Permissions or the sandbox
   4. A skill, for knowledge needed only sometimes
   5. One line in CLAUDE.md, only if Claude would get it wrong without it. Keep that file short.

   Tie each fix to the moment in the session it would have changed.

Signal catalogue, rubric and template: `references/audit.md`.

## Mode 3: multi-agent team design

- **Start from the check** that proves the whole result works. That check is the team's done-criterion.
- **One owner per file**, and one git worktree per parallel worker.
- **Every brief has** a goal, a done-check, out-of-scope, interfaces, and a report contract:
  - status: done / partial / blocked
  - evidence
  - what wasn't verified
  - deviations
  - disagreements with the brief
  - issues seen in teammates' areas

  Say explicitly that "partial" with reasons is a good outcome and a false "done" is the worst one.
- **Accountability is peer-first.** Use a fresh-context reviewer with a mandate to fail, and have consumers check the interfaces they depend on. The orchestrator re-runs the headline check as a backstop. Treat every report as a claim.
- **Surface disagreements** between agents. Decide them or escalate to the user, record the decision and re-brief.
- **Match model strength** to how hard each role is.

Templates and anti-patterns: `references/team-design.md`.

## Other skills

These complement this skill if installed:
- `confession-box`: a full sweep for shortcuts
- `superpowers:verification-before-completion`
- `superpowers:receiving-code-review` and `mattpocock-skills:grilling`
- `superpowers:brainstorming` and `superpowers:writing-plans`
- `superpowers:subagent-driven-development` and `superpowers:dispatching-parallel-agents`

When one of them already owns a step, add only what this skill uniquely brings.

Other skills can invoke this one with "five-dysfunctions checkpoint", "five-dysfunctions audit" or "review this team design".
