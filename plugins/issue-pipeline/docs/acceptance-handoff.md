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

The four workflows are on `main` of both sandboxes, installed by pull request 18 and corrected by pull request 19 in each. Three ship runs started on issue 1 of the public sandbox. None got as far as stage 0, so the acceptance tasks are still to do and the two results files still do not exist.

What went wrong, in the order it appeared:

1. The fresh sandboxes had 12 open issues carrying the `pipeline` label. A dry run of the sweep (`pipeline.mjs sweep --dry-run`) showed that the first scheduled `pipeline-ready` run after the merge would have started issues 1 to 6 at once in each sandbox. The Phase 2b plan expects that sweep to start nothing. The label was removed from all 24 issues before the merge, and one issue is labelled at a time.
2. The first value stored in `PIPELINE_TOKEN` was not a token. `pipeline-ready` failed with `HTTP 401: Bad credentials` until the owner stored a real fine-grained token. That token reaches only the public sandbox. On the private one `pipeline-ready` still fails on every run, with "Could not resolve to a Repository with the name 'AndresRubio/pipeline-sandbox-private'", so the token's repository access has to include the private sandbox as well.
3. The three Claude workflows passed `--disallowedTools` without quotes. `claude-code-action` splits `claude_args` on whitespace, the tool patterns contain spaces, and Claude Code exited with `unknown option '--force:*),Bash(git'`. Fixed in commit `9548eae`, with a test in `test/workflows.test.mjs` that reads each `claude_args` the way the action does.
4. The value stored in `CLAUDE_CODE_OAUTH_TOKEN` starts with a space, so Anthropic answers `401 Invalid bearer token` and the run ends two seconds after Claude Code starts, at no cost. The action hides that message. The run log shows only `is_error: true` with `total_cost_usd: 0` and an empty `modelUsage`. Two things identify it: a local `claude -p` with a made-up token returns the same result, and the log prints the secret as `claude_code_oauth_token:  ***` with two spaces, where a sound secret prints one. `claude setup-token` prints the token wrapped over two lines, each starting with a space, so copying it from the terminal picks up the space and may lose the second line. The owner replaced it the same day with a script that never shows the token: it records `claude setup-token` with `script(1)`, takes the 108 characters that start with `sk-ant-` out of the recording, checks them with `claude -p`, and pipes them to `gh secret set`. That script is not in the repository.
5. A run that dies before Claude starts posts nothing and leaves the `pipeline` label on the issue. The sweep then counts the issue as new and starts it again every 30 minutes. Remove the label while a failure of this kind is being fixed.
6. With a working token the third run still did nothing. Claude Code in a headless run denies Bash and file writes unless `--allowedTools` names them, and `claude-code-action` adds none in agent mode. The session had three permission denials, ended after 13 seconds, and reported success. The spec (§6.2) asks for `--allowedTools` limited to what the stages need, and the templates had none. They now allow `Bash,Read,Write,Edit,Glob,Grep,Skill,Agent,Task,TodoWrite` for ship and `Bash,Read,Write,Glob,Grep` for review and score. A local `claude -p` with `--setting-sources project` showed the denial without the list, the commands running with it, and `git push --force` and `gh pr merge` still refused by `--disallowedTools`.
7. That third run finished green. A ship run in which Claude gives up leaves the workflow successful, the issue labelled and no comment, so nothing tells the owner and the sweep starts the issue again every 30 minutes at a few cents a time. Version 0.3.1 adds a step after the Claude step, `pipeline.mjs ship-status`, that looks for the run folder Setup creates. When there is none, and the run posted no comment of its own, it posts a `blocked` comment, adds `needs-decision` and fails the job. It has not run in Actions yet.
8. A workflow changed on a branch cannot be tried before it is merged. A `workflow_dispatch` of `pipeline-ship` from the fix branch ended in 40 seconds with "Skipping action due to workflow validation": `claude-code-action` refuses to run unless the workflow file is identical to the one on the default branch. Every workflow fix therefore needs a merge by the owner before a run can test it.
9. The stages name skills from `superpowers` and `mattpocock-skills` (writing-plans, test-driven-development, code-review, research and others), and the README lists both plugins as requirements. On the runner only `issue-pipeline` is loaded, through `--plugin-dir`. No run has gone far enough to show what the agent does without them. The spec (§6.2, §10) wants dependencies pinned to a tag or commit, so adding them is a decision for the owner.
10. No `schedule` run of `pipeline-ready` appeared in either sandbox in the two and a half hours after the merge. Every run so far came from a pull request event, a `workflow_run` or a manual dispatch, so the 30-minute sweep has not been seen working.
11. `scanText: pathological 200 KB inputs scan in linear time` in `test/hydrate.test.mjs` failed once with 587 ms against its 500 ms limit while the machine was busy, and passed on the next two runs.

To check a token before storing it, without showing it to a session, the owner can run this in the Terminal app:

```bash
read -s T
CLAUDE_CODE_OAUTH_TOKEN="$T" claude -p "say hi"
printf %s "$T" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo AndresRubio/pipeline-sandbox
printf %s "$T" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo AndresRubio/pipeline-sandbox-private
unset T
```

The second line answers with a greeting when the token is good and with `Failed to authenticate` when it is not.

Version 0.3.1 holds the three workflow fixes (items 3, 6 and 7). The sandboxes still pin `issue-pipeline--v0.3.0`: their workflows were regenerated from the fixed templates for items 3 and 6, and they get the `ship-status` step once setup is run again with `--plugin-ref issue-pipeline--v0.3.1`. Do that after a first run has passed stage 0 on the workflows they have now, so that one change is tested at a time.

The local acceptance of Phase 1 (Task 18 of the Phase 1 plan) has not run either, and the Phase 2a plan asks for it first. It runs `claude -p "/issue-pipeline:ship #N --mode auto"` on this machine, and its prerequisites are the owner's: a fine-grained token limited to the two sandboxes, saved at `~/.config/issue-pipeline/sandbox-token`, HTTPS remotes in the sandbox clones so that pushes use that token, and branch protection on the public sandbox's `main`. On 2026-11-12 none of the three was in place: the folder does not exist, the clones push over SSH with the owner's key, and `main` is not protected. A local run without them would hold the owner's whole GitHub account, so none was started.

## First complete run, 2026-11-12

After pull request 20 put the allowed tools on `main` of the public sandbox, issue 1 ("Added dates show the wrong month") went from label to pull request 21.

- Attempt 1 of run 43175653397 took the lock and ended two minutes later as a success: 37 turns, 0.46 dollars, one permission denial, and no grade, branch or stop comment. It left `pipeline-working` on the issue. The cause is unknown. The action hides the session, and a rerun with debug logging does not show it either.
- Attempt 2, the same run after `pipeline-working` was removed by hand, went through stages 0 to 10 in 304 seconds: 113 turns, 1.39 dollars by the action's count and 1.18 in `run.json`. The grade was `small-gaps` with two assumptions. The change is one line in `src/list.ts` and three tests, and CI passed.
- `pipeline-review` ran on `claude-fable-5-1` for 210 seconds (24 turns, 1.94 dollars) and posted `human-decision-needed` with one Important judgment finding: the spec's own criterion "checked by running the app" has no screenshot. The check failed, which is what a verdict other than `accepted` is meant to do.
- `pipeline-ready` then failed. `gh issue comment 1` was refused with "Resource not accessible by personal access token (addComment)", so the `PIPELINE_TOKEN` has no write access to issues. The owner has to add read and write on Issues to that token, and the private sandbox to its repository access (item 2 of the first list).

What the run showed about the plugin:

1. The workflows check the plugin out at `.issue-pipeline-plugin/` inside the repository. `npm test` then collects the plugin's own tests and fails with 59 files. The agent ran `vitest` with that folder excluded and said so in evidence.md. The plugin should be checked out outside the workspace.
2. `mattpocock-skills:code-review` and confession-box were not installed, so stage 8 was Claude reviewing its own 18-line diff, as evidence.md states. This is item 9 above, seen in practice.
3. The preview did not start. Its command was denied permission and the session has no browser tool, so no screenshot was taken. That is the finding the reviewer raised.
4. evidence.md says "Cost: Unknown" while `run.json` on the same branch holds the cost.
5. Every pipeline comment starts a `pipeline-ship` run that the route job turns down, four in this run. They cost seconds and no Claude usage.
6. A scheduled `pipeline-ready` run did appear, at 03:59 UTC, four and a half hours after the merge. Item 10 above was written before it.
7. The `ship-status` step of version 0.3.1 would not have caught attempt 1, because that session started and then stopped with the lock held. The lock goes stale after `lockTtlHours` (3 hours) and the sweep should then start the issue again. That was not waited for.

Version 0.3.2 answers items 1 and 7. The workflows clone the plugin into `$RUNNER_TEMP/issue-pipeline-plugin`, outside the workspace, with `git clone --depth 1 --branch <tag>` in place of `actions/checkout`, whose `path` has to stay inside the workspace. `ship-status` also asks whether the run still holds the issue's lock when the job is over, and if so posts `blocked`, adds `needs-decision`, removes `pipeline-working` and fails the job. Neither change has run in Actions. Items 2 and 3 are open: the other plugins are still not on the runner, and why the preview command was denied is not known.

Neither results file is written. This was one fixture on one sandbox, and the acceptance tasks in the plans cover more.

## Conventions this work followed

Git identity `AndresRubio <2109109+AndresRubio@users.noreply.github.com>`. On this machine the default SSH key for `github.com` belongs to another account; AndresRubio repositories push through the `github.com-personal` alias, which the clones already use. Commit messages and pull request bodies carry no attribution lines. Pull requests are merged by the owner, since the app's permission classifier refuses a merge from a session. Commit message files go in the session scratchpad under a unique name, and their first line is checked in a call of its own before the commit, because two hooks in this repository can refuse a whole Bash command and a retry then commits a stale file.
