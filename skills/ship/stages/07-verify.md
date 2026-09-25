# Stage 7: Verify

Prove the change works with fresh evidence, including what a user would see.

## Inputs

WT, BASE_SHA, `$RUN_DIR/checks.txt`, `$RUN_DIR/config.json` (`preview`), `docs/pipeline/<KEY>/spec.md`.

## Steps

1. Follow superpowers:verification-before-completion. Run every command in `checks.txt` fresh, in WT. Create `docs/pipeline/<KEY>/evidence.md` from `templates/evidence.md` if it doesn't already exist (fix mode reuses it: replace the Commands table with the fresh results and add to the other sections instead of recreating the file). For each command record the command, its exit code and its last 5 lines of output in the Commands table.
2. **Any command red:** diagnose it (mattpocock-skills:diagnosing-bugs), fix it test-first, commit, and re-run all the commands. At most 2 fix attempts.
3. **Visible change?** From `git diff --name-only "$BASE_SHA"...HEAD` and the spec, decide whether this changes what a user sees: markup, styles, text, rendered data. Record yes or no and why under "Visible change".
4. **If yes and the config has `preview`:**
   1. `node "$PIPELINE" free-port` gives PORT.
   2. `node "$PIPELINE" preview-start --config-file "$RUN_DIR/config.json" --port "<PORT>" --cwd "$WT" --log "$RUN_DIR/preview.log" --pid-file "$RUN_DIR/preview.pid"`. If it fails, write "Visual check needed: preview did not start" and skip to step 5.
   3. For each changed screen reachable by URL: `node "$PIPELINE" screenshot --url "http://localhost:<PORT>/<path>" --out "docs/pipeline/<KEY>/screenshots/<n>-<what>.png"`.
   4. For a state that needs interaction (clicking, typing), use the session's browser tool if one exists, and describe what you saw.
   5. List every screenshot under "Screenshots": the file, what it shows, and which AC it demonstrates.
   6. `node "$PIPELINE" preview-stop --pid-file "$RUN_DIR/preview.pid"`, on every path out of step 4.
   7. If `screenshot` fails for any reason, write "Visual check needed: screenshot failed — <the error>" and carry on.
5. **If yes and there's no `preview`:** write "Visual check needed: no preview command configured." **If no:** write "Not applicable."
6. Under "Departures from spec", list every place the implementation differs from spec.md and why, or write "None."
7. Tick stage 7. Commit (`docs(pipeline): evidence for #<NUMBER>`) and push: `git push origin "$BRANCH"`.

## Outputs

evidence.md (Commands, Visible change, Screenshots, Departures from spec) and the screenshots, committed and pushed.

## Automatic mode

Still red after 2 attempts: stop procedure, with the failing command and its output.

## Interactive mode

Still red after 2 attempts: show the failures and ask. For a visible change, show the screenshots and ask whether they look right.
