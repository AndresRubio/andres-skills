# andres-skills

Personal [Claude Code skills](https://code.claude.com/docs/en/skills).

| Skill | What it does |
|---|---|
| [`cleanup`](skills/cleanup/SKILL.md) | End-of-session cleanup: scans the current repository and the session scratchpad for what the session left behind (worktrees under `.claude/worktrees`, `claude/*` branches and their remote copies, untracked files, scratch files), shows a plan, removes the merged and temporary items, and asks per item before anything that still holds work goes. |
| [`five-dysfunctions`](skills/five-dysfunctions/SKILL.md) | Lencioni's *The Five Dysfunctions of a Team* applied to Claude Code sessions and agent teams: live working norms, session audits (with a transcript condenser and signal scan), and multi-agent team design. Bilingual (EN/ES). |

## Plugins

| Plugin | What it does |
|---|---|
| [`claude-pipeline`](plugins/claude-pipeline/README.md) (SDLC-Forward) | Issue-to-PR pipeline for Claude Code: `/claude-pipeline:ship` takes a GitHub issue or a free-text idea through research, grade, spec, plan, build, verify, self-review and pull request, with a run guard hook that blocks pushes to the base branch and PR merges. Design in [`docs/superpowers/specs/`](plugins/claude-pipeline/docs/superpowers/specs/2026-09-24-claude-pipeline-design.md), status in [`docs/phase1-build-report.md`](plugins/claude-pipeline/docs/phase1-build-report.md). |

Install from the marketplace: `claude plugin marketplace add https://github.com/AndresRubio/andres-skills.git` then `claude plugin install claude-pipeline@andres-skills`. For development, `claude --plugin-dir plugins/<name>` still works.

## Install

```bash
git clone https://github.com/AndresRubio/andres-skills.git
mkdir -p ~/.claude/skills
ln -s "$PWD/andres-skills/skills/five-dysfunctions" ~/.claude/skills/five-dysfunctions
ln -s "$PWD/andres-skills/skills/cleanup" ~/.claude/skills/cleanup
```

Claude Code picks up skills in `~/.claude/skills/` automatically.

## Evals

Each skill keeps its eval prompts and fixtures in `evals/`. See [`skills/five-dysfunctions/evals/README.md`](skills/five-dysfunctions/evals/README.md).
