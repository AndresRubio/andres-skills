---
name: setup
description: Install claude-pipeline into the current repository - the three GitHub workflows (claude-ship, claude-review, pipeline-ready), the seven labels and a starter .claude/pipeline.json - and explain the Claude GitHub App and the two secrets the owner must add. Use when the user runs /claude-pipeline:setup or asks to set up, install or enable the pipeline in a repo.
---

# setup

Installs the GitHub lane and the readiness gate in the current repo. Interactive only: every step that changes GitHub asks first.

## Steps

1. `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)` and `ROOT=$(git rev-parse --show-toplevel)`. Show them and ask "Install claude-pipeline into <REPO>?". Stop on no.
2. Ask which CI workflow names must pass before a PR is ready (default `CI`). These are workflow `name:` values, and their job names must match `ciChecks` in `pipeline.json`.
3. `node "<this skill's base directory>/../ship/scripts/pipeline.mjs" setup --repo-root "$ROOT" --ci-workflows "<names>"`. Show `written` and `skipped`. Skipped files exist already; offer `--force` only if the user asks to replace them.
4. Open `.claude/pipeline.json` and ask the user to confirm `ciChecks` (job names), `mergeDeploys`, `protectedPaths`, `maxParallel` and `preview`. Edit on request.
5. Labels: ask "Create or update the seven labels on <REPO>?". On yes, for each entry in `LABELS` (`skills/ship/scripts/lib/setup.mjs`): `gh label create "<name>" --color "<color>" --description "<description>" --force`. If a `ship-it` label exists, say it is retired and leave it.
6. Install the Claude GitHub App on this repository: run `/install-github-app` in Claude Code, or open https://github.com/apps/claude and select the repo. Workflows run as `claude[bot]` through it.
7. Secrets (Settings → Secrets and variables → Actions). Never ask for a token value and never read it.
   - `CLAUDE_CODE_OAUTH_TOKEN`: tell the user to run `claude setup-token` on their machine and add the result.
   - `PIPELINE_TOKEN` (required for the fix lane and branch updates): a fine-grained personal access token for the repo owner, scoped to this repo, with permissions `contents: write`, `issues: write` and `pull-requests: write`. Events made with the default `GITHUB_TOKEN` start no workflows, so without it the `claude-fix` labels and branch updates that `pipeline-ready` makes would never trigger `claude-ship`, CI or `claude-review`. Without it `pipeline-ready` still labels and comments, and its log shows a warning.
8. Ask: "Commit the written files on branch `claude-pipeline-setup`, push it, and open a PR?" Stop on no. On yes: `git switch -c claude-pipeline-setup`, add the written files, commit with the trailer `Co-Authored-By: Claude <model running this session> <noreply@anthropic.com>`, `git push -u origin claude-pipeline-setup`, `gh pr create`. Workflows on a PR branch don't run until merged; say so.
9. After the user merges: "Label an issue `claude` to start a run. `pipeline-ready` will label its PR `ready` when it is yours to merge."

## Notes

- The workflows pin the plugin to `claude-pipeline--v<version>` of `AndresRubio/andres-skills`. To upgrade, re-run setup with `--plugin-ref <new tag> --force` on a branch and review the diff. `--force` replaces only the three workflows; an existing `.claude/pipeline.json` is never overwritten.
- A public repo may also add branch protection on the default branch with `test` and `claude-review` as required checks. It changes nothing in the process: you still merge.
- `PIPELINE_TOKEN` is required for the fix lane and for branch updates: only events made with it (not with the default `GITHUB_TOKEN`) start `claude-ship`, CI and `claude-review`. Its comments come from the owner's account, which the pipeline reads as its own when they carry a marker. `pipeline-ready` falls back to the default token without it, so the gate still labels and comments, but fix requests and branch updates then stall.
