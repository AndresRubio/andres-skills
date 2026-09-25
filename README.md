# claude-pipeline

Take a work item from a GitHub issue (or a free-text idea) to a reviewed pull request with Claude Code.
Design: `docs/superpowers/specs/2026-09-24-claude-pipeline-design.md`.

## Prerequisites

- Claude Code with the `superpowers` and `mattpocock-skills` plugins.
- The `confession-box` skill in `~/.claude/skills` (optional; stage 8 has a fallback).
- `gh` logged in, git, Node 22+, Chrome/Chromium for screenshots.
- The target repo has `.claude/pipeline.json` on its default branch and the 7 labels (`claude`, `claude-go`, `needs-local`, `needs-decision`, `claude-working`, `ship-it`, `claude-fix`). `sandbox/setup-sandbox.sh` shows how they are created.

## Use

```bash
claude --plugin-dir /path/to/claude-pipeline
```

Then, in the target repo:

- `/claude-pipeline:ship <#N | issue URL | "idea">` — interactive mode.
- Add `--mode auto` to run automatically.
- `/claude-pipeline:ship <PR> --fix` — apply review feedback to an existing PR.

Worktrees live at `~/.claude-pipeline/worktrees/<repo>/<KEY>`. Environment variables: `CLAUDE_PIPELINE_HOME`, `CLAUDE_PIPELINE_LANE`, `CLAUDE_PIPELINE_CHROME`.

Phase 1 ends at an open PR — you merge it yourself.

Q10: the short `/ship` alias is unverified; use `/claude-pipeline:ship`.

## Develop

```bash
npm test
claude plugin validate . --strict                          # validates the marketplace
claude plugin validate .claude-plugin/plugin.json --strict  # validates the plugin
```

## Testing

`sandbox/` holds the test app and seeded issues, plus `setup-sandbox.sh` / `recreate-issue.sh`, which create GitHub repos — run them only deliberately. `acceptance/verify-fixture.mjs` checks a sandbox run's issue, PR, comments and artifacts against `acceptance/fixtures.json`.

## Credits

The spec template and the review and splitting approach are adapted from mattpocock/skills (MIT License, Copyright (c) 2026 Matt Pocock). The pipeline reuses skills from obra/superpowers (MIT).
