# Stage 0: Resolve and lock

Work out what the source is, load the repo's pipeline config, check the issue may be worked, and take the lock.

## Inputs

- The `/ship` arguments: `<source>` and MODE.
- The current directory: a clone of the target repo.
- `CLAUDE_PIPELINE_LANE` (runners set it; default `github` in automatic mode).

## Steps

1. `node "$PIPELINE" source "<source>" > "$RUN_DIR/source.json"`. If `kind` is:
   - `linear`: say "Linear sources arrive in Phase 3 of claude-pipeline" and stop, changing nothing.
   - `github-pr`: stop and say "Pass --fix to work on a pull request."
   - `text` in automatic mode: stop, "Automatic runs start from an issue, not free text."
2. `git fetch origin --prune`. If it fails, stop (hard rule 7).
3. `node "$PIPELINE" config > "$RUN_DIR/config.json"`. On error, stop and show the error: the repo needs a valid `.claude/pipeline.json` on its default branch. BASE_REF is the `ref` field.
   - `enabled` false: stop, changing nothing.
   - `tracker.type` isn't `github`: stop, "Linear adapter arrives in Phase 3."
4. `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)` and `REPO_ROOT=$(git rev-parse --show-toplevel)`.
5. If `kind` is `text` (interactive only), follow "Free text" below, then continue. Otherwise NUMBER is `number` and KEY is `key`.
6. `tracker:read-issue`.
7. LANE is `$CLAUDE_PIPELINE_LANE` (default `github`) in automatic mode, and `manual` in interactive mode. Run `tracker:open-claude-pr-count`, giving N, then:
   `node "$PIPELINE" eligibility --issue-file "$RUN_DIR/issue.json" --config-file "$RUN_DIR/config.json" --lane "$LANE" --open-claude-prs N > "$RUN_DIR/eligibility.json"`
8. `node "$PIPELINE" branch-name --key "$KEY" --title "<issue title>"`: BRANCH is its `branch`.
9. Take the lock:
   - `tracker:add-labels` `claude-working`
   - `tracker:post-comment` kind `lock`, with the body "Run started — lane <LANE>, mode <MODE>, branch `<BRANCH>`."
   - `tracker:set-in-progress`
   - If the issue has `needs-decision`, `tracker:remove-labels` `needs-decision`: this run is the resume.

### Free text (interactive only)

1. Use superpowers:brainstorming with the text as the idea. Follow it until the user approves the design, then stop it there: don't let it write a spec file, commit, or invoke writing-plans. The user's `/ship` instructions override the skill's terminal steps.
2. Write the approved design to `$RUN_DIR/idea-spec.md`, following `templates/spec.md`.
3. Show it and ask: "Create a GitHub issue with this spec?" On yes, `tracker:create-issue` with the spec as the body. On no, stop.
4. NUMBER is the new issue's number. Run `node "$PIPELINE" source "#<NUMBER>"`; KEY is its `key`. Stage 4 reuses `idea-spec.md`.

## Outputs

KEY, NUMBER, REPO, REPO_ROOT, BRANCH, BASE_REF, LANE; `$RUN_DIR/{source,config,issue,eligibility}.json`; the lock on the issue.

## Automatic mode

- `eligible` false: print the reasons and stop **without** the stop procedure. Change nothing on the tracker.
- A parent with open sub-issues is already ineligible (hard rule 8).

## Interactive mode

- `lock.locked` and not `lock.stale`: tell the user which run holds it (the lock comment's time and run link) and stop. Never take a lock over.
- A stale lock: say so and ask whether to continue. On yes, carry on; the new lock comment supersedes the old one.
- `openSubIssues` isn't empty: list them, ask which to work on, and restart this stage with that number.
