# Session audit: signals, evidence, rubric, template

## Contents
1. Workflow with the script
2. Evidence standard
3. Signal catalogue per level
4. Rating rubric and root cause
5. Where fixes belong (mechanism ladder)
6. Report template
7. Example finding

## 1. Workflow with the script

```bash
python3 <skill-dir>/scripts/condense_transcript.py <session.jsonl> --subagents --signals --out <file>
```

Write `<file>` somewhere private, such as the session's scratchpad, not a shared `/tmp`: transcripts can contain secrets.

- The header gives the size and the noise removed. That covers duplicate records re-appended to the file, harness messages dropped, background notifications, tool errors, and how many thinking blocks were empty.
- **SIGNALS** lists heuristic candidates per level, each with a raw line number. Treat each one as a lead. Open the timeline around it, confirm or discard it, and never copy it into the report unchecked.
- The **timeline** prefixes every event with its raw JSONL line (`L123`). Subagent briefs appear up to `--max-chars` (600 by default) with their full length; rerun with `--max-chars 0` to read them whole, because a vague brief is evidence of a commitment failure. For a very long session, use `--range START:END` to read the main timeline one window at a time; subagent timelines always print in full.
- In real transcripts most thinking blocks are empty. Absence of visible doubt isn't evidence that there was none.

## 2. Evidence standard

Every finding needs:
- **Where:** `L123`, or `agent-x:L45` for a subagent file.
- **What it shows:** a short quote or the tool call.
- **Claim type:**
  - *shown*: the transcript contains it
  - *inferred*: your reading of it
  - *unknown*: the transcript can't settle it. Environment facts, the state of the repo after the session and production behavior usually fall here.

An audit that states inferences as facts commits the level-1 dysfunction it is meant to catch.

Redact secrets (tokens, keys, passwords, connection strings) in anything you quote.

## 3. Signal catalogue

### Level 1: Ausencia de confianza (invulnerability)
- A tool error that later assistant text never mentions.
- An edit that reverts an earlier edit, with no explanation.
- Certainty contradicted later, with no check made before it was stated ("no se usa en ningún sitio", followed by an ImportError).
- A third attempt at something the user already corrected twice, instead of saying "I'm going in circles".
- Invented APIs, paths or results.
- A subagent report with no caveats on non-trivial work.
- *Healthy:* flags uncertainty early, volunteers its own mistakes, keeps a deviation log.

### Level 2: Temor al conflicto (artificial harmony)
- Agreement ("¡Buena idea!", "You're right") right after a user proposal, with no check in between.
- Doubt in the reasoning ("risky", "but the user wants…") that never reaches the user.
- A risky request (disable a test, `--force`, drop a table, `migrate --fake`) with no pushback.
- Rubber-stamp reviews: "LGTM" with no concrete checks.
- Disagreeing subagent outputs merged without the conflict being surfaced.
- *Destructive conflict, also unhealthy:* re-arguing after the user decided, debating trivia, attacking the person rather than the idea.
- *Healthy:* one clear objection with evidence and a recommendation, then full commitment.

### Level 3: Falta de compromiso (ambiguity)
- No goal or no done-check before substantial work.
- Scope that grows ("ya que estoy…") with no decision.
- Decisions reopened without new information, or lost after `/compact` or `/clear` because they only lived in the chat.
- Two half-built alternatives in the code.
- Subagent briefs of one or two lines, with no done-check, no out-of-scope and no report format.
- At the end, the user and the agent describe the delivery differently.
- *Healthy:* goal and check stated early, a plan the user could annotate, decisions written down.

### Level 4: Evitación de responsabilidades (low standards)
- "Tests pass" with no test command shown, after running only a subset, or after a failing run.
- Subagent reports relayed without verification.
- Shortcuts: `skip`, `xfail`, `--no-verify`, `migrate --fake`, `# type: ignore`, weakened assertions.
- Agreed rules skipped (CLAUDE.md, specs, conventions).
- Integration never run end to end.
- *Healthy:* claims backed by output; peers and reviewers able to fail work; the orchestrator re-checks the headline claims.

### Level 5: Falta de atención a los resultados (status and ego)
- The final report leads with activity (files, lines, agents) instead of the outcome.
- The user's stated goal (latency, runtime, a bug gone) is never measured.
- "Should work", "debería bajar" offered in place of a measurement.
- A proxy gamed: tests green because of mocks, skips or hardcoding.
- The agent defends its approach against evidence.
- *Healthy:* the outcome is measured the way the user would see it, and the report leads with the gaps.

### User-side signals (tactful, only when relevant)
- Approving without reading.
- Pressure for "done" over "correct".
- Changing goals without saying so.
- Overruling without hearing the objection.
- Merging or deploying on an unmeasured claim.
- Punishing "I'm not sure", which teaches the agent to hide doubt.

## 4. Rating rubric and root cause

| Label (ES / EN) | Meaning |
|---|---|
| OK / OK | No meaningful signals, or the agent caught and corrected them itself |
| RIESGO / AT RISK | Signals present but caught cheaply, before real cost |
| FALLO / BROKEN | The signals caused real cost: rework, a wrong result, a false claim that reached the user, a risky action |

If the evidence is too thin to rate a level, write "sin señal suficiente" / "not enough signal".

**Root:** for each RIESGO or FALLO finding, ask which lower-level failure made it possible. Name as root the lowest level whose fix would have prevented the most findings. Name one, and say why it isn't the next level up.

## 5. Where fixes belong (mechanism ladder)

CLAUDE.md is advice; a hook is a rule. Pick the strongest mechanism that fits the failure, and keep CLAUDE.md short.

| Failure pattern | Mechanism that holds |
|---|---|
| "Tests pass" claimed without running the suite | A `Stop` / `SubagentStop` hook, or a CI gate that runs the full suite; the report shows the command and its output |
| Writes to a dangerous path (migrations, prod config) | A `PreToolUse` hook that blocks or asks |
| Lint or format drift | A `PostToolUse` hook that lints after edits |
| Shortcuts (`skip`, `--no-verify`, `--fake`) | A `PreToolUse` hook that inspects the command, or a CI check, that rejects them. Permission deny rules on arguments are easy to get around: use them only as a backup |
| Approval fatigue (the user approving without reading) | Pre-approve the safe tools, use the sandbox for the rest, and ask only for the risky ones |
| Vague subagent briefs, unverified reports | A brief and report template (a skill or a project agent file), plus orchestrator re-verification |
| Goal never measured | A done-check that *is* the measurement (a benchmark script, a timing command) agreed at kickoff |
| Decisions lost across `/compact` or `/clear` | `plan.md` or `decisions.md` in the repo; `/compact` with instructions to keep decisions |
| Going in circles after corrections | `/clear`, plus a rewritten prompt that carries what was learned |
| Something Claude would get wrong without being told | One line in CLAUDE.md |

A `Stop` or `SubagentStop` hook runs after the response, so it can't stop a false claim from appearing. On exit code 2 it keeps Claude working until the claim is fixed. A gate script should read `stop_hook_active` from its input, which is true when Claude is already continuing because of a stop hook, so it can't block forever.

Tie every fix to the moment in the session it would have changed: "At L812 a Stop hook running `pytest -q` would have kept Claude working until it corrected the 'todos los tests pasan' claim, before the user deployed."

## 6. Report template

Use the user's language (Spanish shown). The **first screen** (at most 250 words) holds the verdict, anything urgent and the table: a reader who stops there must know what to do today. The **whole report** is at most **1,500 words**. Don't append code: offer hook scripts or configs as a follow-up. Extra true risks that don't warrant a full finding each get one line under "Otros riesgos".

```markdown
# Retrospectiva de sesión — 5 disfunciones

**Veredicto:** <1–2 lines: overall health, the root, the single most important change.>
**Urgente:** <only if the session left something broken or risky in production/main: what to check now.>

| Nivel | Estado | Evidencia clave |
|---|---|---|
| 5 Resultados | OK/RIESGO/FALLO | L… |
| 4 Responsabilidades | … | … |
| 3 Compromiso | … | … |
| 2 Conflicto | … | … |
| 1 Confianza | … | … |

## Hallazgos (del más caro al más barato)
- **<level> — <title>** (L…, shown/inferred): what happened → impact → root → fix.

## Lo que funcionó
- <healthy behavior, with L…>

## Cambios (del más fuerte al más débil)
- <mechanism> — <exact text/config> — would have changed L…
- **Para ti** (tactful, only if relevant): …

## Límites de esta auditoría
- <what the transcript can't tell: repo state, production, missing subagent files>
```

## 7. Example finding

> - **4 Responsabilidades: "todos los tests pasan" tras ejecutar un solo fichero** (L812, shown). La única ejecución de tests anterior (L790) es `pytest tests/test_writer.py`, y la suite completa falló en L455. Impacto: el usuario desplegó sobre una afirmación falsa. Raíz: nivel 3, porque "terminado" nunca se definió como un check. Arreglo: un hook `Stop` que ejecute `pytest -q` y obligue a corregir la afirmación antes de cerrar el turno, y acordar al empezar "terminado = suite completa + benchmark < 2 min".
