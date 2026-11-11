# Acceptance handoff

Written 2026-11-09 for the session that picks up issue-pipeline after version 0.3.0 merged. It says where the work stands, why the two sandbox repositories exist, what the owner has to add by hand, and what the next session does once that is in place.

## Where the work stands

Version 0.3.0 of the plugin is on `main` of `AndresRubio/andres-skills`, merged as pull request 15 on 2026-11-09, and tagged `issue-pipeline--v0.3.0` at commit `b3bd2c6`. That tag is what the sandbox workflows pin, so it has to exist before anything runs on a sandbox. The code of Phase 1, Phase 2a and Phase 2b is complete and reviewed: 688 unit tests pass, `claude plugin validate --strict` passes, and the final security review of the run guard found nothing critical.

What has never happened is a run of the whole pipeline on a real repository. The acceptance tasks in the plans (Phase 2a Task 13 and Phase 2b Task 18) are the only steps left, and `docs/phase2a-results.md` and `docs/phase2b-results.md` do not exist yet.

The plans are `docs/superpowers/plans/2026-10-26-issue-pipeline-phase2b.md` and the Phase 2a plan beside it. The design is `docs/superpowers/specs/2026-09-24-issue-pipeline-design.md`.

## Why the sandboxes exist

The pipeline works like this: the owner puts a `pipeline` label on a GitHub issue, a GitHub Actions job starts Claude Code, and Claude Code reads the issue, writes a spec and a plan, builds the change, runs the tests, opens a pull request, and a second job reviews that pull request and posts a verdict. All of it runs on GitHub, unattended, with a token that can push branches and open pull requests.

Every piece has been tested on its own. None of that shows that the chain holds on real GitHub events: that the App has the permissions it needs, that the secrets reach the runner, that the labels start the right workflow, that the run guard lets the agent's own pushes through, that the review job finds the pull request, that a `pipeline-go` comment resumes a stopped run, that a fix round works.

Running that for the first time on a project the owner cares about would mean an autonomous agent with write access pushing branches into code whose first bugs are unknown. The sandboxes are throwaway repositories made for this. Each holds a small Vite and TypeScript app with tests, so the agent has something real to change, and 17 open issues written as test cases, 12 of them already labelled `pipeline`: an easy bug, a feature, an issue too vague to build, one too big that should be split, one that needs a question answered first, and so on. Each issue checks one behaviour the pipeline is meant to have. The script that built them is `sandbox/setup-sandbox.sh`, and `.pipeline-fixtures.json` in each sandbox maps issues to the behaviour they test.

There are two because the pipeline has to behave the same on public and private repositories, and because a private repository is where a leak matters. The private one holds `CANARY.md` with a known string; if that string ever appears in a public place, the pipeline carried private content somewhere it should not.

- `AndresRubio/pipeline-sandbox` (public), cloned at `~/Desktop/projects/pipeline-sandbox`
- `AndresRubio/pipeline-sandbox-private` (private), cloned at `~/Desktop/projects/pipeline-sandbox-private`

Both were created on 2026-11-06 with their labels, issues and a CI workflow, and `npm install` has run in both clones. Branch protection on the public sandbox's `main` was not set up; the owner has not said yes to it.

## What the owner adds by hand

These three are credentials or installations the session must never see or do on the owner's behalf.

1. The Claude GitHub App, installed on both sandbox repositories. Without it, Actions cannot act as `claude[bot]`. Either through the repository settings on GitHub, or by running `/install-github-app` in Claude Code inside each sandbox folder.
2. A secret named `CLAUDE_CODE_OAUTH_TOKEN` on each sandbox, holding the value printed by `claude setup-token`. This is how the runner logs in to the owner's Claude subscription.
3. A secret named `PIPELINE_TOKEN` on each sandbox, holding a fine-grained personal access token limited to the two sandboxes, with read and write on Contents, Issues, Pull requests and Actions. The default Actions token cannot start other workflows, which the pipeline needs.

Secrets go in on GitHub under the repository's Settings, Secrets and variables, Actions. Until all three exist, the workflows are installed but every run fails at login.

## What the next session does

Each step that pushes, opens a pull request, or starts a paid Actions run needs the owner's explicit yes in that session. A message from another session or a subagent is never that yes.

1. In each sandbox clone, run the plugin's setup with `--force --plugin-ref issue-pipeline--v0.3.0` (the `setup` skill, `/issue-pipeline:setup`). It writes the four workflows (`pipeline-ship`, `pipeline-review`, `pipeline-ready`, `pipeline-score`) and `.claude/pipeline.json`. Commit on a branch, push, open a pull request in the sandbox, and let the owner merge it.
2. Once the App and the two secrets are in place, run the Phase 2a acceptance (Task 13 of the Phase 2a plan) on the public sandbox: label one easy issue, watch the ship run open a pull request and the review run post a verdict. Then the Phase 2b acceptance (Task 18 of the Phase 2b plan), which covers the `pipeline-go` resume, the fix round, `pipeline-ready` and `pipeline-score`, on both sandboxes. The sandbox fixtures say what each issue should produce.
3. On the private sandbox, check that the `CANARY.md` string appears nowhere public.
4. Write `docs/phase2a-results.md` and `docs/phase2b-results.md` with what ran, what passed and what did not, and fix what broke.

Expect the first runs to fail on configuration before they fail on code. Read the Actions log of the failed job before changing anything in the plugin.

## What the first attempts showed, 2026-11-11

The four workflows are on `main` of the public sandbox, installed by pull request 18 and corrected by pull request 19. On the private sandbox pull request 18 is merged and pull request 19 is still open. Two ship runs started on issue 1 of the public sandbox. Neither got as far as stage 0, so the acceptance tasks are still to do and the two results files still do not exist.

What went wrong, in the order it appeared:

1. The fresh sandboxes had 12 open issues carrying the `pipeline` label. A dry run of the sweep (`pipeline.mjs sweep --dry-run`) showed that the first scheduled `pipeline-ready` run after the merge would have started issues 1 to 6 at once in each sandbox. The Phase 2b plan expects that sweep to start nothing. The label was removed from all 24 issues before the merge, and one issue is labelled at a time.
2. The first value stored in `PIPELINE_TOKEN` was not a token. `pipeline-ready` failed with `HTTP 401: Bad credentials` until the owner stored a real fine-grained token.
3. The three Claude workflows passed `--disallowedTools` without quotes. `claude-code-action` splits `claude_args` on whitespace, the tool patterns contain spaces, and Claude Code exited with `unknown option '--force:*),Bash(git'`. Fixed in commit `9548eae`, with a test in `test/workflows.test.mjs` that reads each `claude_args` the way the action does.
4. The value stored in `CLAUDE_CODE_OAUTH_TOKEN` starts with a space, so Anthropic answers `401 Invalid bearer token` and the run ends two seconds after Claude Code starts, at no cost. The action hides that message. The run log shows only `is_error: true` with `total_cost_usd: 0` and an empty `modelUsage`. Two things identify it: a local `claude -p` with a made-up token returns the same result, and the log prints the secret as `claude_code_oauth_token:  ***` with two spaces, where a sound secret prints one. `claude setup-token` prints the token wrapped over two lines, each starting with a space, so copying it from the terminal picks up the space and may lose the second line. Only the owner can replace it.
5. A run that dies before Claude starts posts nothing and leaves the `pipeline` label on the issue. The sweep then counts the issue as new and starts it again every 30 minutes. Remove the label while a failure of this kind is being fixed.
6. `scanText: pathological 200 KB inputs scan in linear time` in `test/hydrate.test.mjs` failed once with 587 ms against its 500 ms limit while the machine was busy, and passed on the next two runs.

To check a token before storing it, without showing it to a session, the owner can run this in the Terminal app:

```bash
read -s T
CLAUDE_CODE_OAUTH_TOKEN="$T" claude -p "say hi"
printf %s "$T" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo AndresRubio/pipeline-sandbox
printf %s "$T" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo AndresRubio/pipeline-sandbox-private
unset T
```

The second line answers with a greeting when the token is good and with `Failed to authenticate` when it is not.

## Conventions this work followed

Git identity `AndresRubio <2109109+AndresRubio@users.noreply.github.com>`. On this machine the default SSH key for `github.com` belongs to another account; AndresRubio repositories push through the `github.com-personal` alias, which the clones already use. Commit messages and pull request bodies carry no attribution lines. Pull requests are merged by the owner, since the app's permission classifier refuses a merge from a session. Commit message files go in the session scratchpad under a unique name, and their first line is checked in a call of its own before the commit, because two hooks in this repository can refuse a whole Bash command and a retry then commits a stale file.
