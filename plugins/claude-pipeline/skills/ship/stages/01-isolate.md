# Stage 1: Isolate

Give the issue its own working copy and branch, outside the main checkout, and prove the base is healthy.

## Inputs

KEY, BRANCH, BASE_REF, REPO_ROOT, `$RUN_DIR/config.json`.

## Steps

1. Create or reuse the working copy. Don't use the harness's native worktree tool, because it puts worktrees inside the repo.
   - Normally: `node "$PIPELINE" worktree --repo-root "$REPO_ROOT" --key "$KEY" --branch "$BRANCH" --base "$BASE_REF" > "$RUN_DIR/worktree.json"`
   - If `${CI:-}` is `true` (a disposable CI checkout), add `--in-place`.

   WT is its `path`. From here on, the command prefix is `. '<RUN_DIR>/vars.sh' && cd "$WT" && ` (SKILL.md Setup step 2).
2. If `resumed` is true and `docs/pipeline/<KEY>/progress.md` exists in WT: take only BASE_SHA and TASKS from its Run table (append them to vars.sh) — the base may have moved, so keep the recorded BASE_SHA rather than recomputing it — and rewrite the Run table's other rows with this run's values (KEY, NUMBER, REPO, REPO_ROOT, BRANCH, WT, BASE_REF, MODE, LANE all come from this run, not the old one: this differs from the same-run recovery in SKILL.md Setup step 2). Before jumping: if the issue has a comment with `pipeline: true` and kind `blocked` (the latest one), read the trusted replies — comments with `trusted: true` and `pipeline: false` (hard rule 2) — posted after it. Copy the decision(s) under a "## Decisions" section in progress.md (create it if missing) and apply them in the stage you jump to. `claude-go` on the issue means: accept the recommendations in that `blocked` comment. Run steps 3 and 4 to rebuild the dependencies and `$RUN_DIR/checks.txt`, then jump to its first unticked stage. Stop reading this file.
3. Install dependencies the way the repo does:
   - `package-lock.json` → `npm ci`
   - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
   - `yarn.lock` → `yarn install --frozen-lockfile`
   - `go.mod` → `go mod download`
   - `Cargo.toml` → `cargo fetch`
   - otherwise → the install command the README or CLAUDE.md documents
4. Find the check commands. For each name in the config's `ciChecks`, find the job with that id or `name:` in `.github/workflows/*.yml` and copy its `run:` steps in order, skipping checkout, setup and install steps. Write them to `$RUN_DIR/checks.txt`, one per line. If a named check isn't found, stop: the config names a check CI doesn't have.
5. Baseline: run every command in `checks.txt` in WT. All must pass.
6. `BASE_SHA=$(git rev-parse "$BASE_REF")`.
7. Create `docs/pipeline/<KEY>/progress.md` from `templates/progress.md`. Fill in the Run table and tick stages 0 and 1. Don't commit yet.
8. Check the size of the repo's instructions file: `wc -l CLAUDE.md` (and `wc -l AGENTS.md` if it exists), run in WT. Over 200 lines, add a line under "Known issues" in progress.md: "CLAUDE.md is N lines; Anthropic recommends under 200" (name AGENTS.md instead when that is the long one). Never edit either file: they belong to the repo owner. Interactive mode: also say it to the user in one line.

## Outputs

WT, BASE_SHA, `$RUN_DIR/checks.txt`, `docs/pipeline/<KEY>/progress.md` (uncommitted).

## Automatic mode

A red baseline: stop procedure, and remove the worktree (it may be removed). The decision needed is "The base branch is red; fix it first", with the failing command and its last 20 lines of output.

## Interactive mode

A red baseline: show the failures and ask whether to continue anyway.
