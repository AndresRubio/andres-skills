# Stage 0: Resolve and lock

Work out what the source is, load the repo's pipeline config, check the issue may be worked, and take the lock.

## Inputs

- The `/ship` arguments: `<source>` and MODE.
- The current directory: a clone of the target repo.
- `CLAUDE_PIPELINE_LANE` (runners set it; default `github` in automatic mode).

## Steps

1. Write `<source>` to `$RUN_DIR/source.txt` with the file-writing tool, then `node "$PIPELINE" source "$(cat "$RUN_DIR/source.txt")" > "$RUN_DIR/source.json"`. If `kind` is:
   - `linear`: say "Linear sources arrive in Phase 3 of claude-pipeline" and stop, changing nothing.
   - `github-pr`: stop and say "Pass --fix to work on a pull request."
   - `text` in automatic mode: stop, "Automatic runs start from an issue, not free text."
2. `git fetch origin --prune`. If it fails, stop (hard rule 7).
3. `node "$PIPELINE" config > "$RUN_DIR/config.json"`. On error, stop and show the error: the repo needs a valid `.claude/pipeline.json` on its default branch. BASE_REF is the `ref` field.
   - `enabled` false: stop, changing nothing.
   - `tracker.type` isn't `github`: stop, "Linear adapter arrives in Phase 3."
4. `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)` and `REPO_ROOT=$(git rev-parse --show-toplevel)`. If `source.json` has a `repo` field and `<owner>/<repo>` isn't REPO, stop: "This checkout is <REPO>; run /ship from a clone of `<owner>/<repo>`."
5. If `kind` is `text` (interactive only), follow "Free text" below, then continue. Otherwise NUMBER is `number` and KEY is `key`.
6. `tracker:read-issue`.
7. LANE is `${CLAUDE_PIPELINE_LANE:-github}` in automatic mode, and `manual` in interactive mode. Run `tracker:active-runs`, then:
   `node "$PIPELINE" eligibility --issue-file "$RUN_DIR/issue.json" --config-file "$RUN_DIR/config.json" --lane "$LANE" --active-runs-file "$RUN_DIR/active-runs.json" > "$RUN_DIR/eligibility.json"`
   Act on `eligibility.json` now, following the mode section below for this MODE; continue to step 8 only if the mode section lets the run continue.
8. `gh pr list --repo "$REPO" --state open --limit 100 --json number,headRefName,isCrossRepository --jq '[.[] | select((.isCrossRepository | not) and (.headRefName == "claude/<KEY>" or (.headRefName | startswith("claude/<KEY>-"))))]' > "$RUN_DIR/existing-prs.json"`. If it isn't empty, stop without changing anything, and say "PR #<n> is already open for this issue; use `/claude-pipeline:ship <n> --fix`."
9. `node "$PIPELINE" branch-name --key "$KEY" --issue-file "$RUN_DIR/issue.json"`: BRANCH is its `branch`.
10. Take the lock:
   - `tracker:add-labels` `claude-working`
   - `tracker:post-comment` kind `lock`, with the body "Run started — lane <LANE>, mode <MODE>, branch `<BRANCH>`."
11. Count again, now that this run holds the lock: `tracker:active-runs` with `--expect-locked`, overwriting `active-runs.json`. Only the runs in `ahead` count now. The command fails if `self.lockedAt` is still `null` after its one retry: this run's own lock isn't visible. If it fails, apply hard rule 7.
   - In automatic mode, if `admitted` is false, back off:
     1. `tracker:post-comment` kind `deferred`, with the body "Deferred: <n> runs are ahead of this one (<label for each key in ahead>) and `maxParallel` is <M>. A later run picks it up once a slot frees: the sweep, the next poll, or `/ship #<NUMBER>`." A label is `#<n>` for a numeric key, `PR #<n>` for `PR-<n>`, and the key itself otherwise.
     2. `tracker:remove-labels` `claude-working`. The `deferred` comment goes first, so a crash between the two can't leave this lock looking like the start of the next run.
     3. `rm -rf "$RUN_DIR"`, as stage 10 does.
     4. Stop here. This is not the stop procedure: `needs-decision` and `claude-go` stay as they are.
   - In interactive mode, if `admitted` is false, tell the user "<n> runs are ahead and `maxParallel` is <M>; continuing because you started this run."
12. `tracker:set-in-progress`. If the issue has `needs-decision`, `tracker:remove-labels` `needs-decision`: this run is the resume.

### Free text (interactive only)

1. Use superpowers:brainstorming with the text as the idea. Follow it until the user approves the design, then stop it there: don't let it write a spec file, commit, or invoke writing-plans. The user's `/ship` instructions override the skill's terminal steps.
2. Write the approved design to `$RUN_DIR/idea-spec.md`, following `templates/spec.md`.
3. Show it and ask: "Create a GitHub issue with this spec?" On yes, `tracker:create-issue`: the title is the approved design's one-line title, written to a title file under `$RUN_DIR` (never typed into the command, per `trackers/github.md`); the spec is the body. On no, stop.
4. NUMBER is the new issue's number. Run `node "$PIPELINE" source "#<NUMBER>"`; KEY is its `key`. Stage 4 reuses `idea-spec.md`.

## Outputs

KEY, NUMBER, REPO, REPO_ROOT, BRANCH, BASE_REF, LANE; `$RUN_DIR/{source,config,issue,eligibility,existing-prs,active-runs}.json`; the lock on the issue.

## Automatic mode

- `eligible` false: print the reasons and stop here, before step 8, without the stop procedure. Change nothing on the tracker.
- A parent with open sub-issues is already ineligible (hard rule 8).

## Interactive mode

- `lock.locked` and not `lock.stale`: tell the user which run holds it (the lock comment's time and run link) and stop here, before step 8. Never take a lock over.
- A stale lock: say so and ask whether to continue. On yes, carry on to step 8; the new lock comment supersedes the old one.
- `openSubIssues` isn't empty: list them, ask which to work on, and restart this stage with that number.
