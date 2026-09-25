# Stage 1: Isolate

Give the issue its own working copy and branch, outside the main checkout, and prove the base is healthy.

## Inputs

KEY, BRANCH, BASE_REF, REPO_ROOT, `$RUN_DIR/config.json`.

## Steps

1. Create or reuse the working copy. Don't use the harness's native worktree tool, because it puts worktrees inside the repo.
   - Normally: `node "$PIPELINE" worktree --repo-root "$REPO_ROOT" --key "$KEY" --branch "$BRANCH" --base "$BASE_REF" > "$RUN_DIR/worktree.json"`
   - If the environment variable `CI` is `true` (a disposable CI checkout), add `--in-place`.

   WT is its `path`. From here on, run every command inside WT (`cd "$WT"`).
2. If `resumed` is true and `docs/pipeline/<KEY>/progress.md` exists in WT: restore the variables it records (keep its BASE_SHA, since the base may have moved), run steps 3 and 4 to rebuild the dependencies and `$RUN_DIR/checks.txt`, then jump to its first unticked stage. Stop reading this file.
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

## Outputs

WT, BASE_SHA, `$RUN_DIR/checks.txt`, `docs/pipeline/<KEY>/progress.md` (uncommitted).

## Automatic mode

A red baseline: stop procedure, and remove the worktree (it may be removed). The decision needed is "The base branch is red; fix it first", with the failing command and its last 20 lines of output.

## Interactive mode

A red baseline: show the failures and ask whether to continue anyway.
