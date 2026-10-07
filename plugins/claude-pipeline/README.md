# claude-pipeline

Take a work item from a GitHub issue (or a free-text idea) to a reviewed pull request with Claude Code.
Design: `docs/superpowers/specs/2026-09-24-claude-pipeline-design.md`.

## Prerequisites

- Claude Code with the `superpowers` and `mattpocock-skills` plugins.
- The `confession-box` skill in `~/.claude/skills` (optional; stage 8 has a fallback).
- `gh` logged in, git, Node 22+, Chrome/Chromium for screenshots.
- The target repo has `.claude/pipeline.json` on its default branch and the 7 labels (`claude`, `claude-go`, `needs-local`, `needs-decision`, `claude-working`, `claude-fix`, `ready`). `/claude-pipeline:setup` installs them; `sandbox/setup-sandbox.sh` shows how they are created for the sandbox repos.

## Use

```bash
claude --plugin-dir /path/to/claude-pipeline
```

Then, in the target repo:

- `/claude-pipeline:ship <#N | issue URL | "idea">` — interactive mode.
- Add `--mode auto` to run automatically.
- `/claude-pipeline:ship <PR> --fix` — apply review feedback to an existing PR.

Worktrees live at `~/.claude-pipeline/worktrees/<repo>/<KEY>`. Environment variables: `CLAUDE_PIPELINE_HOME`, `CLAUDE_PIPELINE_LANE`, `CLAUDE_PIPELINE_CHROME`.

A run ends at an open PR. With the Phase 2a workflows installed (`/claude-pipeline:setup`), `claude-review` posts a verdict, `pipeline-ready` keeps the branch current and labels the PR `ready` when it is yours to merge. Nothing merges on its own.

## Workflows

`/claude-pipeline:setup` installs three GitHub Actions workflows from `templates/github/` into the target repo:

- `claude-ship` — the GitHub lane: routes labeled issues, comments and PR labels to a ship or fix run.
- `claude-review` — reviews each `claude/*` PR and posts a verdict for its head commit.
- `pipeline-ready` — deterministic, no AI: keeps the branch current, requests a fix when needed, and labels the PR `ready` once CI is green, the verdict is accepted and the branch is current. It never merges.

Before they can run, install the Claude GitHub App on the repository (`/install-github-app` in Claude Code, or https://github.com/apps/claude); the workflows run as `claude[bot]` through it. They need two repository secrets: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and `PIPELINE_TOKEN`, a fine-grained personal access token for the repo owner, scoped to the repo, with `contents`, `issues` and `pull-requests` write. `PIPELINE_TOKEN` is required for the fix lane and branch updates: events made with the default `GITHUB_TOKEN` start no workflows, so without it a `claude-fix` label or a branch update never triggers `claude-ship`, CI or `claude-review`.

## Review

`/claude-pipeline:review <PR> --head <sha>` reviews a pipeline PR at that head commit and posts one of three verdicts:

- `accepted` — nothing blocks the merge.
- `revision-needed` — findings with file, line, problem and correction; a fix run works through them.
- `human-decision-needed` — judgment findings that need the owner's reply before a fix run can act.

Q10: the short `/ship` alias is unverified; use `/claude-pipeline:ship`.

## Runs in progress

A run in progress is an open `claude/*` PR from this repo, or an open issue whose `claude-working` lock is fresh (newer than `lockTtlHours`). A PR and its issue's lock are one run. A run counts from its first `lock` comment after the issue's latest `report`, `blocked`, `questions`, `split`, `deferred` or `stale-lock` comment. Runs with an open PR are ahead of runs without one; otherwise the earlier lock is ahead.

- **The cap.** Before taking the lock, a run counts every run in progress against `maxParallel`. After taking it, stage 0 counts again, and only the runs ahead count. If `maxParallel` or more are ahead, an automatic run backs off: it posts `deferred`, releases the lock and stops. A later run picks the issue up (in Phase 1, run `/ship` again). An interactive run only reports the count. The cap is soft: GitHub's read lag can, rarely, let two runs that lock at almost the same moment both back off or both go ahead.
- **The wait.** Research checks each run ahead for work this issue builds on, changes to the same code, or a decision both depend on. A parent or sub-issue never counts. If one of them overlaps, the grade is `wait`: the run posts `deferred`, ending with a `Waiting for: <keys>` line, checks that it reads back, releases the lock and stops. Eligibility holds the issue back while any of those runs is still in progress, and frees it as soon as none is, however they ended. Nothing links the issues, so there is nothing to clean up, and a waiting issue holds no lock, so waits can't deadlock. Phase 1 has no sweep or poll to restart it: run `/ship` again.
- **Overriding it.** Add `claude-go` to the issue to let it run alongside the runs it would wait for: eligibility stops holding it back, and the grade goes ahead. In interactive mode, the grade asks whether to wait or go ahead alongside, and on a fork or too-big grade it asks this before the fork questions or the split choice. Either way, grade.md records who chose to go ahead.

## Run guard

The plugin ships a `PreToolUse` hook (`hooks/guard.mjs`) that checks every Bash command while a `/ship` run is in progress.

- **Pushes.** It allows `git push origin "$BRANCH"` or `git push -u origin "$BRANCH"` (or a literal `claude/…` branch) and nothing else. `$BRANCH` has to come from the run's `vars.sh`, sourced first in the same command, and its last `BRANCH` line has to be a `claude/*` branch. A command that pushes may contain only that source, `cd`, `git add`, `git commit` (not `--no-verify`), `git status` and a `| tail` or `| head` of the push's output, joined by `&&`, with no substitutions, assignments or redirections (except to `/dev/null` or `2>&1`). So nothing in it can change what gets pushed.
- **Blocked outright**, pushing or not: any other push (other branches, refspecs, remotes, `--force`, `--mirror`, git options before `push`, a push inside `bash -c` or an alias, a git/gh subcommand hidden in a variable or glob, `git send-pack`/`http-push`/`remote-*` plumbing, `eval`); merging (`gh pr merge` in any spelling, the merge API, GraphQL merge and ref mutations, `gh alias`, writes through the git-refs or contents APIs); `gh repo sync`/`edit`/`delete`/`rename`/`archive`; changing `git remote` URLs or, through `git config`, the config that steers pushes (`remote.*`, `url.*`, `alias.*`, `include.*`, `protocol.*`, `core.hooksPath` and so on); command-line git config (`git -c`, `--config-env`) for any key except `core.quotepath`, `color.*`, `user.name`, `user.email`, `advice.*` and `init.defaultBranch`; and environment redirection: any `VAR=value` before a `git` or `gh` command, and setting `GIT_*`, `GH_*`, `HOME`, `XDG_CONFIG_HOME`, `XDG_CONFIG_DIRS`, `PATH`, `SSH_ASKPASS` or `SSH_AUTH_SOCK` anywhere in the command (`export`, `declare -x` and `env` included).
- A blocked command exits 2 with the reason on stderr, and the skill then follows its stop procedure. `git commit -m "… push …"` is a known false positive: commit messages go through `-F <file>`.

`CLAUDE_PIPELINE_GUARD` controls it: set `1` for runners (always on), `0` to switch it off, or leave it unset for automatic. Automatic means the guard switches on for a session once that session runs the Setup command (the one that creates `<home>/runs/run-XXXXXX`) or sources a run's `vars.sh`, which is before any issue text is read. Just mentioning the pipeline home (`ls ~/.claude-pipeline/runs/`, `grep CLAUDE_PIPELINE_HOME`) doesn't switch it on. The guard remembers that with a marker file `<home>/guard/<session id>` and deletes markers older than 14 days.

To switch it off for a session you started by mistake, delete `<home>/guard/<session id>`, or start Claude Code with `CLAUDE_PIPELINE_GUARD=0` (the hook reads the environment Claude Code started with). The deny message doesn't mention this on purpose.

It is a seatbelt, not a security boundary. It doesn't cover a `.git/config` or a git hook edited by a file write in an earlier call, a script written to a file and then run, commands assembled from strings at run time inside an interpreter (`node -e`, `python -c`, `sh -c`, or a `git rebase --exec`/`git submodule foreach` string with pieces joined at run time), or GitHub API writes whose endpoint is assembled from variables. Scoped tokens and branch protection are the boundary for those, so pair it with a token scoped to the repo and with branch protection on the default branch.

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
