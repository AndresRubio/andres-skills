# claude-pipeline

Take a work item from a GitHub issue (or a free-text idea) to a reviewed pull request with Claude Code.
Design: `docs/superpowers/specs/2026-09-24-claude-pipeline-design.md`.

## Prerequisites

- Claude Code 2.1.220 or later, with the `superpowers` and `mattpocock-skills` plugins installed.
- `gh` logged in; `git`; Node 22 or later; Google Chrome or Chromium for screenshots.
- The target repo has `.claude/pipeline.json` on its default branch.

## Use

```bash
claude --plugin-dir /path/to/claude-pipeline
```

Then, in the target repo: `/claude-pipeline:ship #12` (interactive) or `/claude-pipeline:ship #12 --mode auto`.

## Develop

```bash
npm test
claude plugin validate . --strict
```

## Credits

The spec template and the review and splitting approach are adapted from mattpocock/skills (MIT License, Copyright (c) 2026 Matt Pocock). The pipeline reuses skills from obra/superpowers (MIT).
