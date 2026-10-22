---
name: cleanup
description: "End-of-session cleanup for Claude Code: find and remove what this session left behind in the current repository (worktrees under .claude/worktrees, claude/* and other branches it created, their remote branches, untracked files it wrote) and in its scratchpad. Use it whenever the user signals the session is ending or wants its leftovers gone: 'clean up', 'cleanup', 'limpia', 'recoge', 'we're done', 'wrap up', 'close this out', 'remove the worktree', 'delete the branch', 'borra lo temporal', after a PR merges, before archiving the session, or when they ask what the session left lying around. Also use it when, while finishing work, you notice stale worktrees or merged branches of your own. It covers this session and this repository only, never other repositories, running processes or the app's storage."
---

# Cleanup

A session leaves things behind: worktrees it opened, branches whose pull
request has merged, a scratchpad full of probes, logs and workspace folders in
the repository. This skill removes them with two guarantees. Nothing is deleted
before the user has seen a plan, and nothing that still holds work (uncommitted
changes, commits not on the base branch, a remote branch) goes without a yes
for that specific item.

The script does the looking and the deleting, so the classification is the same
every time. Your job is the judgment in between: what belongs to this session,
what the user already decided, and how to put the plan to them.

## Scope

This session, this repository. That means the main checkout, worktrees under
`.claude/worktrees/`, branches named `claude/*`, branches you created in this
conversation, their copies on origin, untracked files written since the session
started, and the session scratchpad.

Leave alone: other repositories, worktrees outside `.claude/worktrees/`
(someone made those by hand), gitignored caches such as `.venv` or
`__pycache__`, background processes, and the app's own folders. A session knows
what it made; sweeping the machine from inside one session deletes other
sessions' work. If the user wants more than that, they will say so, and that is
a different job.

## Steps

### 1. Gather what only you know

- The repository: the current directory, or the project folder the session
  moved to. With no git repository at all (a scratch-only session), skip git
  and pass `--no-repo`.
- The scratchpad: the "Scratchpad directory" the system prompt names. Do not
  guess it from `/tmp`.
- When the session started: the time of the first message, or a safe earlier
  bound. Untracked files older than that are kept, so when in doubt go earlier.
- Branches you created here that are not named `claude/...`: each goes in a
  `--branch` flag, or the script will not consider them session work.
- Decisions the user already made in their message ("keep the report worktree",
  "the remote branches can go too"). Those answer the questions below in
  advance; do not ask them again.

### 2. Scan

```bash
python3 <skill-dir>/scripts/cleanup.py scan \
  --repo <repo> --scratchpad <scratchpad> --since <ISO time> \
  [--branch <name>]... --out <scratchpad>/cleanup-plan.json
```

It prints three groups with a reason per line and writes the plan file. SAFE is
merged work and the scratchpad. ASK is anything that would lose something.
KEEP is what the script will refuse to touch. Ids are only stable within one
plan file; a rescan renumbers them, so apply from the file you just wrote.

### 3. Check for other sessions

`.claude/worktrees/` holds the worktrees of every session on this repository,
yours among them. When the `mcp__ccd_session_mgmt__list_sessions` tool exists,
call it. A worktree that is another session's working directory, or a branch
that is another session's branch, is theirs: treat it as KEEP whatever the
script said, and name the session when you report. Without the tool, a worktree
you did not open whose files changed in the last few hours is probably another
session's: KEEP it and say why.

### 4. Put the plan to the user

Describe each item in plain words: what it is, why it is safe or not, and what
would be lost. Then ask once, with `AskUserQuestion`: confirm the SAFE group as
a whole, and pick from the ASK items one by one (a multi-select question, one
option per item, with what each holds in its description). Remote branch
deletions are visible to other people, so they stay in ASK even when the branch
is merged.

If the user already answered in their message, skip the question for those
items. If you cannot ask (no question tool, the user said they are away or said
to do only what is safe), apply the SAFE group and finish by listing every ASK
item with its id and reason, so that one more message closes the job. Never
pick for the user; a kept worktree costs disk, a deleted one costs their work.

### 5. Apply

```bash
python3 <skill-dir>/scripts/cleanup.py apply <plan.json> --ids wt2,br1,sp
```

Only the ids you pass run. The script refuses KEEP items and any delete that
points outside the repository or the scratchpad.

This is the one step that destroys things, so expect the app to ask the user
to approve the command, and in auto mode it may refuse it outright. A refusal
is an answer: report the plan with its ids and stop. Do not split the deletes
into smaller commands or run them by hand to get past it.

If this session is running inside one of the worktrees, the script marks it
KEEP because the process cannot delete its own floor. When `EnterWorktree`
opened it in this conversation, `ExitWorktree` with `remove` closes it
(`discard_changes` only after the user agreed to lose them). Otherwise the app
removes it when the session is archived; say so instead of forcing it.

### 6. Verify and report

Run the same scan again with `--no-fetch`. Report in a few lines: what went,
what stayed and why, and what still waits on a decision, each with its id and
what would be lost. Say what could not be checked (no `gh`, no network, a fetch
that failed) because that changes how sure "merged" is.

## Judgment calls the script cannot make

| You are about to… | Instead |
|---|---|
| Approve the ASK items yourself because they look obvious | Ask. Obvious to you is the one that hurts when wrong. |
| Decide a branch is merged, or not, from `git branch --merged` alone | The script also checks the pull request and patch equivalence, which catches a one-commit squash. A multi-commit squash still looks unmerged to every check. Report the commit count, the pull request state and an empty diff against the base if you find one, and let the user decide. |
| Delete an untracked folder because its name looks like junk | A `*-workspace/` or `.superpowers/` folder may be a deliverable the user keeps (this very repository commits eval workspaces). It stays in ASK. |
| Delete the remote branch along with the merged local one | Other people and open tabs point at it. It is in ASK for a reason. |
| Tidy the other stale worktrees "while you are here" | Out of scope. Mention them in one line; the user can ask for a sweep. |
| Remove the scratchpad directory itself | Only its contents. The app owns the directory. |
| Clean up before showing anything | The plan comes first, even when everything is SAFE. |

## Script reference

`scripts/cleanup.py` has two subcommands and `--help` for each.

- `scan` reads one repository and one scratchpad and writes a plan. It fetches
  origin with `--prune` first (skip with `--no-fetch`), finds the base branch
  from `origin/HEAD` (else main, master, develop), and asks `gh` for the pull
  request state of each branch when `gh` is installed. It changes nothing.
- `apply` runs the actions of the chosen ids: `git worktree remove` and
  `git branch -d` for SAFE items (git itself refuses if work would be lost),
  the `--force` and `-D` forms only for ASK items the user approved,
  `git push origin --delete` for remote branches, and plain deletes inside the
  repository or scratchpad. `--dry-run` prints the commands instead.

Merged means any of: the pull request is merged (`gh`), the tip is an ancestor
of the base, or every commit has a patch-equivalent on the base (`git cherry`,
which catches a one-commit squash or a rebase). Worktree verdicts: dirty means
ASK; merged, or a detached HEAD already on the base, means SAFE; anything else
means ASK with the number of commits at stake. A worktree whose folder is
already gone is a SAFE prune, unless its branch still has unmerged commits.
