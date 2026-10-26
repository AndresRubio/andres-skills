# Stage 7: Verify

Prove the change works with fresh evidence, including what a user would see.

## Inputs

WT, BASE_SHA, `$RUN_DIR/checks.txt`, `$RUN_DIR/config.json` (`preview`), `docs/pipeline/<KEY>/spec.md`.

## Steps

1. Follow superpowers:verification-before-completion. Run every command in `checks.txt` fresh, in WT, each one redirected to its own log in one command: `<command> > "$RUN_DIR/logs/verify-<n>.log" 2>&1` (use the test runner's quiet flag, such as `--reporter=dot`, `--silent` or `-q`). Read the result in a separate command: `tail -n 40 "$RUN_DIR/logs/verify-<n>.log"`, or `grep -E 'error|fail|warn' "$RUN_DIR/logs/verify-<n>.log" | head -40`. Create `docs/pipeline/<KEY>/evidence.md` from `templates/evidence.md` if it doesn't already exist (fix mode reuses it: replace the Commands table with the fresh results and add to the other sections instead of recreating the file). The Commands table records each command, the log path and the exit code, not the output.
2. **Any command red:** diagnose it (mattpocock-skills:diagnosing-bugs), fix it test-first, commit, and re-run all the commands. At most 2 fix attempts.
3. **Revert check** (spec §7.4). Take the command in `checks.txt` that runs the test suite (the one that invokes the `test` script; if there are several, the first). Run `node "$PIPELINE" revert-check --base "$BASE_SHA" --command "<that command>" > "$RUN_DIR/revert.json"`. Read the result as one of these outcomes and record it under "Revert check" in evidence.md:
   - `skipped` is true: record the reason. No finding.
   - `error` is not null: the check could not run. Record "Revert check could not run: <error>" and carry on. Do not treat it as a pass: `failed` false then does not mean the tests passed against the base. Stage 8 and `claude-review` will see it.
   - `error` is null and `failed` is false: **the new tests pass without the change**, so they don't exercise it. Record the test files and the exit code. Treat that as an Important finding now: add or sharpen a test so that it fails against the base, commit, and run this step again. At most 1 attempt; if it still passes, record it and carry on. Stage 8 and `claude-review` will see it.
   - `error` is null and `failed` is true: good. Record the test files, the exit code and `failed`.
4. **Visible change?** From `git diff --name-only "$BASE_SHA"...HEAD` and the spec, decide whether this changes what a user sees: markup, styles, text, rendered data. Record yes or no and why under "Visible change".
5. **If yes and the config has `preview`:**
   1. `node "$PIPELINE" free-port` gives PORT.
   2. `node "$PIPELINE" preview-start --config-file "$RUN_DIR/config.json" --port "<PORT>" --cwd "$WT" --log "$RUN_DIR/preview.log" --pid-file "$RUN_DIR/preview.pid"`. If it fails, write "Visual check needed: preview did not start" and skip to step 6.
   3. For each changed screen reachable by URL: `node "$PIPELINE" screenshot --url "http://localhost:<PORT>/<path>" --out "docs/pipeline/<KEY>/screenshots/<n>-<what>.png"`. The command captures the 1280x800 viewport, never the full page, and writes one file per changed screen. The PNG files are evidence for the PR and the user. Don't read them into your context, unless an acceptance criterion needs a visual judgement: then read one at a time.
   4. For a state that needs interaction (clicking, typing), use the session's browser tool if one exists, and describe what you saw.
   5. List every screenshot under "Screenshots": the file, what it shows, and which AC it demonstrates.
   6. `node "$PIPELINE" preview-stop --pid-file "$RUN_DIR/preview.pid"`, on every path out of step 5.
   7. If `screenshot` fails for any reason, write "Visual check needed: screenshot failed — <the error>" and carry on.
6. **If yes and there's no `preview`:** write "Visual check needed: no preview command configured." **If no:** write "Not applicable."
7. Under "Departures from spec", list every place the implementation differs from spec.md and why, or write "None."
8. Tick stage 7. Commit (`docs(pipeline): evidence for #<NUMBER>`) and push: `git push origin "$BRANCH"`.

## Outputs

evidence.md (Commands, Revert check, Visible change, Screenshots, Departures from spec), `$RUN_DIR/revert.json` and the screenshots, committed and pushed.

## Automatic mode

Still red after 2 attempts: stop procedure, with the failing command, its log path and the last 20 lines of that log.

## Interactive mode

Still red after 2 attempts: show the failures and ask. For a visible change, give the user the path of each screenshot (not the image) and ask whether they look right.
