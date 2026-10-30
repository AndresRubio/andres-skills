# andres-skills

Personal [Claude Code skills](https://code.claude.com/docs/en/skills).

| Skill | What it does |
|---|---|
| [`cleanup`](skills/cleanup/SKILL.md) | End-of-session cleanup: scans the current repository and the session scratchpad for what the session left behind (worktrees under `.claude/worktrees`, `claude/*` branches and their remote copies, untracked files, scratch files), shows a plan, removes the merged and temporary items, and asks per item before anything that still holds work goes. |
| [`confession-box`](skills/confession-box/SKILL.md) | Honest report of the shortcuts Claude took in a coding session: reads the session log and git diff, walks tests, type and lint suppressions, logic shortcuts, verification and scope drift, lists each confession with its evidence, and suggests `/retro` when a lint rule, hook or CI job could have caught one. |
| [`five-dysfunctions`](skills/five-dysfunctions/SKILL.md) | Lencioni's *The Five Dysfunctions of a Team* applied to Claude Code sessions and agent teams: live working norms, session audits (with a transcript condenser and signal scan), and multi-agent team design. Bilingual (EN/ES). |

## Plugins

| Plugin | What it does |
|---|---|
| [`claude-pipeline`](plugins/claude-pipeline/README.md) (SDLC-Forward) | Issue-to-PR pipeline for Claude Code: `/claude-pipeline:ship` takes a GitHub issue or a free-text idea through research, grade, spec, plan, build, verify, self-review and pull request, with a run guard hook that blocks pushes to the base branch and PR merges. Design in [`docs/superpowers/specs/`](plugins/claude-pipeline/docs/superpowers/specs/2026-09-24-claude-pipeline-design.md), status in [`docs/phase1-build-report.md`](plugins/claude-pipeline/docs/phase1-build-report.md). |

Install from the marketplace: `claude plugin marketplace add https://github.com/AndresRubio/andres-skills.git` then `claude plugin install claude-pipeline@andres-skills`. For development, `claude --plugin-dir plugins/<name>` still works.

## Mods

Mods are plugins whose TypeScript hooks module runs inside the Claude Code session: it can refuse or rewrite tool calls, add a slash command, and draw a pane, a band above the prompt, a status line entry or a toast. Most of these are tied to one of my repos and do nothing anywhere else. They need a Claude Code version with mod support (built and tested on 2.1.309).

| Mod | Where it acts | What it does |
|---|---|---|
| [`check-gate`](plugins/check-gate/) | any repo with `scripts/check.sh` or a `check` script in `package.json` | Reruns the check in the background after a turn that changed code, shows the result above the prompt, and refuses `git commit` while the check fails. `/check-gate` runs it now, `/check-gate log` shows the last output. |
| [`citation-guard`](plugins/citation-guard/) | warhammer | When an edit changes a points or stat value in the army data, tells the model to add a CITATIONS.md entry, and shows a toast at the end of the turn if it didn't. `/citation-guard` lists the changes still missing a citation. |
| [`boe-guard`](plugins/boe-guard/) | boe-agent | Refuses reads of PROGRESS.md and the plans folder without a line limit, and asks the person before a command that loads a month from BDNS or BOE. |
| [`forja-cost-guard`](plugins/forja-cost-guard/) | forja | Asks the person before `forja run --yes`, showing the GPU, the hourly price and the maximum cost. Shows the running cost above the prompt during a run, and reminds to run `forja cleanup` after exit code 3 or an interrupted run. |
| [`digest-guard`](plugins/digest-guard/) | ai-digest | Refuses writes under `site/` that carry a Gmail address or a mailbox link, refuses Gmail tools that write, and runs `digest-routine/check-structure.py` before `git push`. |
| [`mcp-inspector`](plugins/mcp-inspector/) | mcp-lab | A pane listing each MCP tool call with its duration, JSON-RPC error code and the start of its result, with a toast when an email or phone number got past redaction. Keeps a prompt-to-tool log; `/mcp-inspector export <path>` writes it as JSONL. |
| [`jev-status`](plugins/jev-status/) | every session | Shows `local-jev: up` or `down` in the status line, checked every minute, with a toast when the server goes down. `/jev-start` starts it. |
| [`pipeline-pane`](plugins/pipeline-pane/) | any repo running claude-pipeline | A pane showing the current `/claude-pipeline:ship` run: the stage running and its time, finished stages, subagents and the last events, with a toast when the run ends. |

Install one with `claude plugin install <mod>@andres-skills` once the marketplace is added. To check a mod, from its folder: `claude plugin validate .`, `claude plugin test .`, and `tsc -p .` after Claude Code has loaded the mod once, which writes the types its `tsconfig.json` extends into `.claude-plugin/types/`.

## Install

```bash
git clone https://github.com/AndresRubio/andres-skills.git
mkdir -p ~/.claude/skills
ln -s "$PWD/andres-skills/skills/five-dysfunctions" ~/.claude/skills/five-dysfunctions
ln -s "$PWD/andres-skills/skills/cleanup" ~/.claude/skills/cleanup
ln -s "$PWD/andres-skills/skills/confession-box" ~/.claude/skills/confession-box
```

Claude Code picks up skills in `~/.claude/skills/` automatically.

## Evals

Each skill keeps its eval prompts and fixtures in `evals/`. See [`skills/five-dysfunctions/evals/README.md`](skills/five-dysfunctions/evals/README.md).
