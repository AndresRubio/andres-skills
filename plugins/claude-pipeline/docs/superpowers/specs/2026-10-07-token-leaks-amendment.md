# Token leaks amendment (2026-10-07)

Amendment to `2026-09-24-claude-pipeline-design.md`. Status: proposed; nothing below is implemented yet.

**Source.** Andrea Eskailet, "Tus tokens de Claude Code se van así (y cómo pararlo)" (youtube.com/watch?v=TZ1Uh4MZXsk), measured over 25,000+ Claude Code responses from her own sessions. The numbers are hers, not ours; `metrics` (D19) will tell us how far they hold for pipeline runs.

| Leak | Her measurement | What the pipeline does today |
|---|---|---|
| 1. The conversation is re-read on every step | 96.9% of processed tokens are re-reads; step 1 re-reads ~43k, step 100 ~414k | Files are the hand-off (§5), but nothing forces a stage to start in a fresh context |
| 2. Terminal output | 75% of everything tools put into the conversation; up to ~30,000 chars per command, kept forever | No rule on filtering output; no hook |
| 3. Big files, images, PDFs | An image up to ~5k tokens; a PDF pays text plus image per page | `hydrate` caps 64 KB per file × 20 refs (§5.6); stage 7 takes full screenshots |
| 4. Model and effort | Opus is the default everywhere; effort is billed as output | Model tiers are explicit (§5.5); effort is not |
| 5. Subagents | ~Half of API cost; each starts cold; their cache lasts 5 minutes | Model named per dispatch; no rule on size, parallelism or what they return |
| 6. The backpack (CLAUDE.md, memory, tool descriptions) | Re-read every step; CLAUDE.md should stay under 200 lines | SKILL.md is 84 lines and stages load lazily; the target repo's CLAUDE.md is unchecked |
| 7. First response after a pause over 1 hour | Cache expires (1 h on subscription, 5 min on overage); the whole context is re-processed and re-written: ~30–40 normal responses | Interactive stops leave the session idle for as long as you take to answer |

## D21 — Token budget discipline

Every run keeps what the model re-reads small: filtered tool output, bounded inputs, fresh contexts at stage boundaries, subagents dispatched on purpose, no idle sessions across a cache expiry, and cost recorded with the cache split so `metrics` can show which leak a repo has. Rationale: the video's measurements, and D19's finding that cost per `ready` PR is the number to drive down. User decision, 2026-10-07.

## Amendments

### A. Hard rule 11 (§5.3 and SKILL.md): keep tool output short — leak 2

Add as hard rule 11:

> **Keep tool output short.** A command that can print more than ~50 lines sends its output to a file and shows only what the stage needs: `… > "$RUN_DIR/logs/<stage>-<what>.log" 2>&1; tail -n 40 "$RUN_DIR/logs/<stage>-<what>.log"`, or a `grep -E 'error|fail|warn' | head -40` of it. Package installs, dev servers and test runs always go through a log file; test runners get their quiet flag (`--reporter=dot`, `--silent`, `-q`). Never `cat` a file to read it: use the Read tool with a line range or `sed -n`. The evidence Commands table records the log path and the exit code, not the output.

The run guard's allow-list for push commands (§7.2) already permits `| tail` / `| head`; the log redirection goes in a separate command, as the guard requires.

### B. Output-trim hook — leak 2 (Phase 2a or 2b)

A `PostToolUse` hook on Bash, `hooks/trim.mjs`, next to the run guard and switched on by the same marker (`<home>/guard/<session id>`): when a command's output exceeds 4 KB, it writes the full output to `$RUN_DIR/logs/<n>.log` and replaces it with the last 40 lines plus every line matching `error|fail|warn|exception`, and a first line naming the log file. Headless lanes always get it (`CLAUDE_PIPELINE_GUARD=1`). This is the "hook that keeps only the error lines" the video proposes, applied to every command instead of one.

### C. Context hygiene section (SKILL.md) — leaks 1 and 7

Add a "Context hygiene" section after "Stop procedure":

- Stages 2 (research), 6 (build, through subagent-driven-development), 7 (verify) and 8 (review) run in subagents with a bounded brief: the file paths they need under `docs/pipeline/<KEY>/` and `$RUN_DIR`, never the conversation. The orchestrating context carries `progress.md` and the stage files, nothing else.
- A subagent returns a summary of at most 30 lines and the paths it wrote. It never returns raw command output.
- Interactive mode: after stage 5 (plan committed and pushed) and after stage 9 (PR open), say so and recommend `/clear` followed by `/claude-pipeline:ship <KEY>`; stage 1 step 2 already resumes from `progress.md`. `/compact` only at a stage boundary, never inside a build task.
- An interactive stop that waits for the user (needs-decision, finish menu, "do the screenshots look right") is a pause. If the answer is not coming within the hour, end the session: the stop procedure has already written `progress.md`, so the next session resumes from it at the cost of the backpack and a few lines instead of the whole context.
- Headless lanes never idle: `--max-turns` and `timeout-minutes` stay (§6.2), and the 30-minute sweep (§6.1) starts a fresh run rather than waking an old one.

### D. §5.5 — effort joins the model policy — leak 4

Name the effort with the model on each dispatch and at run start, following the global CLAUDE.md effort tiers:

| Work | Model | Effort |
|---|---|---|
| Tracker queries, labels, resolve and lock | haiku | low |
| Research, implementers, evidence write-up | sonnet | medium |
| Grade, spec, plan | strongest available | high |
| Stage 8 review, `claude-review`, conflict resolution | strongest available | high; max only for a `human-decision-needed` re-check |

Headless lanes set it once per run (`--effort` in `claude_args`), interactive runs at stage 0, never mid-run: each model keeps its own cache, so a switch re-processes the whole context. Record the effort per stage in `run.json` next to the model tier.

### E. §5.6 — hydrate bounds and how stage 2 reads them — leak 3

- Total cap of 256 KB per run across all fetched references, on top of the 64 KB per file; over the cap the rest is listed as "not fetched: budget".
- A PDF reference is converted to text (`pdftotext -layout`) and the text is what gets fetched; the PDF itself is never read as pages.
- Stage 2 reads `context/index.md` first (unchanged) and opens a fetched file only when the index shows it matters, by line range. It never reads `context/` wholesale.

### F. Stage 7 screenshots — leak 3

- `screenshot` captures the viewport (1280×800), never the full page; one file per changed screen.
- The PNG files are evidence for the PR and the user. The model does not read them into its context unless an acceptance criterion needs a visual judgement, and then it reads one at a time. Interactive mode shows them to the user with a path, not by loading them.

### G. Subagent rules (§5 and SKILL.md "Model policy") — leak 5

- No subagent for work of three steps or fewer; do it inline. (Stage 6 already builds a plan of three tasks or fewer with one agent.)
- Independent subagents are dispatched in the same message so they run in parallel; a subagent that waits on another pays its whole context again after five minutes.
- Each dispatch carries a bounded brief (see C) and a 30-line return limit.

### H. Backpack check at stage 1 — leak 6

Stage 1 counts the lines of the target repo's `CLAUDE.md` (and `AGENTS.md` if present). Over 200 lines: a line in `progress.md` under Known issues ("CLAUDE.md is N lines; Anthropic recommends under 200") and, in interactive mode, a one-line mention. Never edit it: it is the repo owner's. Plugin side: SKILL.md stays under 100 lines, stages and the tracker adapter stay lazy-loaded, and `gh` stays the GitHub interface (no GitHub MCP in the run: the CLI costs less context).

### I. §7.5 `run.json` cost fields and `metrics` — measuring leaks 1, 5 and 7

Replace the cost group with:

| Field | Meaning |
|---|---|
| `tokens.input`, `tokens.output` | uncached input and output, main session plus subagents |
| `tokens.cacheRead`, `tokens.cacheWrite` | cache reads and cache writes, same scope |
| `tokens.subagents` | the share of all four that subagents report |
| `contextPeak` | largest context length seen in the run, in tokens |
| `pausesOverCacheTtl` | number of gaps over the cache TTL between two steps (interactive runs) |
| `usd` | estimated with cache reads and writes at their published rates, not at the base input price |

`metrics` adds three columns per repo: cache-write share of input (high means leak 1 or 7), subagent share of cost (leak 5), and median `contextPeak` (leaks 2 and 3). The turn caps and `maxParallel` defaults keep being set from these numbers (§9).

## Where it lands

| Amendment | Spec section | Plugin file | Phase |
|---|---|---|---|
| A | §5.3 | `skills/ship/SKILL.md` hard rules; `stages/06-build.md`, `07-verify.md` command examples | 2a |
| B | §7.2 | `hooks/hooks.json`, `hooks/trim.mjs`, tests | 2a or 2b |
| C | §5 | `skills/ship/SKILL.md` new section; `stages/05-plan.md`, `09-finish.md` | 2a |
| D | §5.5 | `skills/ship/SKILL.md` Model policy; `claude-ship.yml` / `claude-review.yml` `claude_args` | 2a |
| E | §5.6 | `hydrate` command, `stages/02-research.md` | 2b |
| F | §5 stage 7 | `screenshot` command, `stages/07-verify.md` | 2a |
| G | §5.5 | `skills/ship/SKILL.md` Model policy | 2a |
| H | §5 stage 1 | `stages/01-isolate.md` | 2a |
| I | §7.5 | `run.json` writer, `metrics` command | 2b |

## Open questions

| # | Question | Default if unanswered |
|---|---|---|
| Q20 | Can the Actions runner report the cache split for `run.json` (extends Q16)? | `null` for the cache fields on Actions |
| Q21 | Does `claude-code-action` accept `--effort` in `claude_args`? | Leave effort at the default on the Actions lane and record it as `default` |
| Q22 | `PostToolUse` hooks: can one replace the tool result Claude sees, or only add context? If only add, B becomes a `PreToolUse` rewrite that appends the log redirection and `tail` to the command | Pre-tool rewrite, gated like the guard |

## Review and disposition (2026-10-13)

Reviewed against `main` at 915ced7 (Phase 2a Tasks 1–12 built, 465 tests; Task 13 acceptance not run). Questions renumbered Q20–Q22: the Phase 2a plan already settles its own Q15–Q19.

**Where each amendment goes.** Phase 2a code is done, so "2a" below means a *2a follow-up*: prose-only edits that land before the acceptance runs and are exercised by them. Anything needing new code waits for 2b.

| Amendment | Disposition | Why |
|---|---|---|
| A hard rule 11 | **2a follow-up** | Prose only. Keep the `tail`/`head` wording aligned with the run guard's push whitelist (§7.2), which already allows them |
| B trim hook | **2b** | Feasible as designed: PostToolUse `hookSpecificOutput.updatedToolOutput` replaces the Bash result Claude sees (shape `{stdout, stderr, interrupted, isImage}`), so no PreToolUse rewrite and no interaction with the guard. New code and tests, and it must be observed on real runs before headless lanes get it unconditionally. Note: telemetry still records the original output |
| C context hygiene | **2a follow-up**, as a lazy-loaded file | SKILL.md is 84 lines and H caps it at 100; A+C+G add ~25–30. Put the section in `skills/ship/context-hygiene.md`, read at Setup step 5, with a two-line pointer in SKILL.md |
| D effort with model | **2a follow-up** | `--effort` is a real CLI flag (`low`…`max`); `claude_args` passes any CLI argument through, so `claude-ship.yml`/`claude-review.yml` can set it per run. `max` is flag-only (the `effortLevel` settings key rejects it). Record `effort` per stage in `run.json` when 2b adds it |
| E hydrate bounds | **2b** | `hydrate` does not exist yet (§5.6 is 2b); fold these bounds into its spec before it is written |
| F screenshots | **2a follow-up**, prose only | Already true in code: `chrome.mjs` captures `--window-size=1280,800`, no full-page flag. Only the "never read PNGs into context" rule is new |
| G subagent rules | **2a follow-up** | Prose only; lives with D in Model policy |
| H backpack check | **2a follow-up** | One `wc -l` in stage 1 and a Known-issues line. Plugin-side limits (SKILL.md < 100 lines, lazy stages) become a `skill-structure.test.mjs` assertion |
| I run.json cache fields | **2b**, defined now | `run.json` and `metrics` don't exist yet; define the cache split before the first writer. Headless `-p --output-format json` reports `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`, `total_cost_usd` and per-model `modelUsage` with the same split. `usage` covers only the main loop and `modelUsage` the whole tree, so `tokens.subagents` = tree − main. Resumed sessions include earlier spend: never sum results across resumes |

**Open questions, answered.**

| # | Answer | Effect |
|---|---|---|
| Q20 | `claude-code-action` exposes no usage or cost outputs (`conclusion`, `execution_file`, `branch_name`, `github_token`, `structured_output`, `session_id` only). `execution_file` contents are undocumented; `show_full_output` prints the JSON to the log but may expose secrets | Default stands: cache fields `null` on Actions. Task for the first sandbox run: inspect `execution_file` for a `result` message; if it carries `usage`, the workflow writes it to `run.json` |
| Q21 | `--effort` exists; `claude_args` passes it through. Alternatives: `CLAUDE_CODE_EFFORT_LEVEL` env, `settings` input `{"effortLevel": …}` (no `max`) | D applies on the Actions lane too; use the flag |
| Q22 | PostToolUse can replace the tool result (`updatedToolOutput`); PreToolUse can rewrite input (`updatedInput`) but is not needed | B stays a PostToolUse hook, gated like the guard |

**Two corrections outside this amendment.** §7.5 states Warp's cost per PR "fell from $80 to $30" as fact; no Warp source found for it (newsletter, warp-factory-examples, two long interviews checked 2026-10-07). Soften to "Warp tracks cost per PR" or cite. And `v0.2.0` is tagged on `main` although Task 13's acceptance never ran (no sandboxes, no `phase2a-results.md`, exit criteria unchecked).

Sources for the answers: code.claude.com/docs/en/hooks, /cli-reference, /model-config, /headless, /agent-sdk/cost-tracking; anthropics/claude-code-action `action.yml`.
