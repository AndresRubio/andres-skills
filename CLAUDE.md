# andres-skills

Skills live in `skills/<name>/SKILL.md`, plugins in `plugins/<name>/`. The one plugin is `plugins/claude-pipeline/`, which the owner also calls SDLC-Forward.

Work on claude-pipeline runs from `plugins/claude-pipeline/`. `npm test` is the suite; a bare `node --test` there also picks up the sandbox app's own tests, which need their `npm install`. `claude plugin validate . --strict` must pass, and `test/version.test.mjs` keeps the three version fields equal. CLI code is `skills/ship/scripts/pipeline.mjs` with `skills/ship/scripts/lib/*.mjs`; tests in `test/` use `test/helpers/{cli,fake-gh,git}.mjs`. Review rules are in `plugins/claude-pipeline/CODING_STANDARDS.md`. Design lives in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`.

The shell is zsh on macOS. Read pipeline exit codes from `$pipestatus`, quote a glob that may match nothing, and remember BSD `sed` has no `\b` and needs `-i ''`.
