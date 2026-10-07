---
name: pipeline-setup
description: Install claude-pipeline into the current repository - the three GitHub workflows (claude-ship, claude-review, pipeline-ready), the seven labels and a starter .claude/pipeline.json - and explain the one secret the owner must add. Use when the user runs /claude-pipeline:setup or asks to set up, install or enable the pipeline in a repo.
---

# pipeline-setup

Installs the GitHub lane and the readiness gate in the current repo. Interactive only: every step that changes GitHub asks first.

## Steps

1. `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)` and `ROOT=$(git rev-parse --show-toplevel)`. Show them and ask "Install claude-pipeline into <REPO>?". Stop on no.
2. Ask which CI workflow names must pass before a PR is ready (default `CI`). These are workflow `name:` values, and their job names must match `ciChecks` in `pipeline.json`.
3. `node "<this skill's base directory>/../ship/scripts/pipeline.mjs" setup --repo-root "$ROOT" --ci-workflows "<names>"`. Show `written` and `skipped`. Skipped files exist already; offer `--force` only if the user asks to replace them.
4. Open `.claude/pipeline.json` and ask the user to confirm `ciChecks` (job names), `mergeDeploys`, `protectedPaths`, `maxParallel` and `preview`. Edit on request.
5. Labels: ask "Create or update the seven labels on <REPO>?". On yes, for each entry in `LABELS` (`skills/ship/scripts/lib/setup.mjs`): `gh label create "<name>" --color "<color>" --description "<description>" --force`. If a `ship-it` label exists, say it is retired and leave it.
6. Secret: tell the user to run `claude setup-token` on their machine and add the result as the repository secret `CLAUDE_CODE_OAUTH_TOKEN` (Settings → Secrets and variables → Actions). Never ask for the token value and never read it.

   Optional second secret `PIPELINE_TOKEN`: a fine-grained personal access token (or GitHub App token) for this repo with `contents: write` and `pull-requests: write`. Without it, `pipeline-ready` still labels and comments, but a branch it updates from the base will not re-run CI or `claude-review`, so such PRs wait until the next push. Never ask for the token value.
7. Commit the written files on a branch and open a PR (`git switch -c claude-pipeline-setup`, add, commit with the trailer, `git push -u origin claude-pipeline-setup`, `gh pr create`). Workflows on a PR branch don't run until merged; say so.
8. After the user merges: "Label an issue `claude` to start a run. `pipeline-ready` will label its PR `ready` when it is yours to merge."

## Notes

- The workflows pin the plugin to `claude-pipeline--v<version>` of `AndresRubio/andres-skills`. To upgrade, re-run setup with `--plugin-ref <new tag> --force` on a branch and review the diff.
- A public repo may also add branch protection on the default branch with `test` and `claude-review` as required checks. It changes nothing in the process: you still merge.
- `PIPELINE_TOKEN` is optional and only affects whether a branch update made by `pipeline-ready` re-triggers CI and `claude-review`; the workflows fall back to the default `GITHUB_TOKEN` without it.
