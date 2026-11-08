# andres-skills

Skills live in `skills/<name>/SKILL.md`, plugins in `plugins/<name>/`. The pipeline plugin is `plugins/issue-pipeline/`, which the owner also calls SDLC-Forward. The other folders in `plugins/` are mods, covered by `plugins/CLAUDE.md`.

Work on issue-pipeline runs from `plugins/issue-pipeline/`. `npm run check` must pass: it runs the suite (`npm test`) and then `claude plugin validate . --strict`. A bare `node --test` there also picks up the sandbox app's own tests, which need their `npm install`. `test/version.test.mjs` keeps the three version fields equal. `scripts/check.sh` at the root runs that check and `scripts/check-mods.sh` for whatever changed on the branch; the check-gate mod runs it after each turn, and `git config core.hooksPath .githooks` turns on the pre-commit hook that runs it before a commit that touches `plugins/`. CLI code is `skills/ship/scripts/pipeline.mjs` with `skills/ship/scripts/lib/*.mjs`; tests in `test/` use `test/helpers/{cli,fake-gh,git}.mjs`. Review rules are in `plugins/issue-pipeline/CODING_STANDARDS.md`. Design lives in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`.

The shell is zsh on macOS. Read pipeline exit codes from `$pipestatus`, quote a glob that may match nothing, and remember BSD `sed` has no `\b` and needs `-i ''`.
