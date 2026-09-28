# andres-skills

Personal [Claude Code skills](https://code.claude.com/docs/en/skills).

| Skill | What it does |
|---|---|
| [`five-dysfunctions`](skills/five-dysfunctions/SKILL.md) | Lencioni's *The Five Dysfunctions of a Team* applied to Claude Code sessions and agent teams: live working norms, session audits (with a transcript condenser and signal scan), and multi-agent team design. Bilingual (EN/ES). |

## Install

```bash
git clone https://github.com/AndresRubio/andres-skills.git
mkdir -p ~/.claude/skills
ln -s "$PWD/andres-skills/skills/five-dysfunctions" ~/.claude/skills/five-dysfunctions
```

Claude Code picks up skills in `~/.claude/skills/` automatically.

## Evals

Each skill keeps its eval prompts and fixtures in `evals/`. See [`skills/five-dysfunctions/evals/README.md`](skills/five-dysfunctions/evals/README.md).
