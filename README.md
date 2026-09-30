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

## Run guard

The plugin ships a `PreToolUse` hook (`hooks/guard.mjs`) that checks every Bash command while a `/ship` run is in progress.

- It allows a push only as `git push origin "$BRANCH"` or `git push -u origin "$BRANCH"` (or a literal `claude/…` branch), run as its own command after sourcing the run's `vars.sh`. `$BRANCH` has to come from that `vars.sh`, and its last `BRANCH` line has to be a `claude/*` branch.
- It blocks any other push (other branches, refspecs, remotes, `--force`, `--mirror`, git options before `push`, a push inside `bash -c` or an alias), and anything that merges: `gh pr merge`, the merge API, GraphQL merge and ref mutations, `gh alias`, and writes through the git-refs or contents APIs. A blocked command exits 2 with the reason on stderr, and the skill then follows its stop procedure.
- `git commit -m "… push …"` is a known false positive: commit messages go through `-F <file>`.

`CLAUDE_PIPELINE_GUARD` controls it: set `1` for runners (always on), `0` to switch it off, or leave it unset for automatic. Automatic means the guard switches on for a session once that session runs a pipeline command (one that mentions `CLAUDE_PIPELINE_HOME`, `<home>/runs/` or `scripts/pipeline.mjs`), which is at Setup, before any issue text is read. It remembers that with a marker file in `<home>/guard/` and deletes markers older than 14 days. Other sessions aren't affected.

It is a seatbelt, not a security boundary: a script written to a file and then run gets past it. Pair it with a token scoped to the repo and with branch protection on the default branch.

## Develop

```bash
npm test
claude plugin validate . --strict                          # validates the marketplace
claude plugin validate .claude-plugin/plugin.json --strict  # validates the plugin
```

## Testing

`sandbox/` holds the test app and seeded issues, plus `setup-sandbox.sh` / `recreate-issue.sh`, which create GitHub repos — run them only deliberately. `acceptance/verify-fixture.mjs` checks a sandbox run's issue, PR, comments and artifacts against `acceptance/fixtures.json`.

Test issue 10 checks that a run on the public sandbox doesn't copy private data into public text. `setup-sandbox.sh <name> private` writes a random marker to `CANARY.md` in the private sandbox. After a run on the public sandbox, pass that file to the checker with `--forbidden-file <path-to-CANARY.md>`: it fails if the marker appears in any issue or PR (title, body, comments, reviews, review comments), any commit comment, or any non-default branch's commits, diffs and binary files (edit history of comments and bodies isn't scanned). A branch too large for GitHub's compare limits can't be scanned and makes the check exit 3.

## Credits

The spec template and the review and splitting approach are adapted from mattpocock/skills (MIT License, Copyright (c) 2026 Matt Pocock). The pipeline reuses skills from obra/superpowers (MIT).
