# Evals for `five-dysfunctions`

Prompts and assertions live in `evals.json` (skill-creator format). Paths in prompts use `{FILES}`, which stands for this folder's `files/` directory.

```bash
bash files/build_fixtures.sh   # builds files/generated/ (gitignored)
```

| id | Mode | Fixture | What it tests |
|---|---|---|---|
| 1 | audit | `generated/session` | Short session with planted dysfunctions; the prompt names Lencioni |
| 2 | team design | none | Express → Fastify agent team |
| 3 | live | `facturas-app` | User insists on a wrong premise (rounding vs. discount) |
| 4 | audit | `generated/sesion-ventas` | 446-line noisy session, no framework named; `long-session-truth.json` holds planted lines for graders |
| 5 | live | `facturas-app` | User overrules the objection: commit fully, state the consequence once |
| 6 | live | `generated/inventario-app` | Integrate subagent work: green tests, broken untested handler, a report that hides a rename |
| 7 | team design | none | Same as 2, graded on budget and runnability |

## Method

1. Run each prompt with the skill, with the previous skill version and without any skill, all on the same model.
2. Copy the outputs into A/B/C folders under a hidden mapping. Redact working paths, because a path containing `without_skill` once leaked a label.
3. An independent grader scores the assertions, fact-checks against the fixture or the web, and ranks the three blind. Graders were Fable for audit and design, and Sonnet for the live evals.

Assertions alone barely discriminate, because the base model already behaves well on most of them. The blind rankings carry the signal. The last assertions of evals 4, 6 and 7 were added from grader feedback after iteration 4.

## Results so far (claude-opus-5-5, 1–2 runs per eval)

| Iteration | Change | Blind outcome |
|---|---|---|
| 1 | First version | Won design and live; lost the audit narrowly to baseline |
| 2 | Leaner, with budgets, peer-first accountability and the mechanism ladder | Won 5 of 6 pairwise; lost design because nothing in it was runnable |
| 3 | "Cut prose, never findings", plus complete runnable appendices | Worse than v2 (mean rank v2 1.67, v3 2.00, baseline 2.33); design ran to 10,854 words |
| 4 (current) | v2 plus: a 250-word first screen for audits; one runnable gate of about 60 lines for designs; one line per extra risk | First in 4 of 4 three-way comparisons (mean rank v4 1.00, v2 2.25, baseline 2.75) |

**Cost of the current version against baseline:** about 20–25% more tokens on audits and live work, and about 45% more on team design, because the design run tests its own gate script.
