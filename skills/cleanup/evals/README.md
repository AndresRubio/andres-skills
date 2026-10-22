# Evals for `cleanup`

One folder per case, in the layout `claude plugin eval` reads: `prompt.md`
(the user's message), `case.yaml` (what a good result looks like), `graders/`
(one checkable statement per file) and `place-files.sh`, which builds the
fixture before the run.

All three cases share one fixture, built by `fixtures/make_fixture.sh DEST`: a
small repository with a bare origin next to it, so remote branch deletion can
be tested offline. It holds a merged worktree, a worktree with uncommitted
work, a clean detached worktree, a merged branch without a worktree, a branch
squash-merged from two commits (so no git check can prove the merge), untracked
files from "this session" and from a week ago, a scratchpad with three files,
and a git-less `notes` folder.

| Case | What it tests |
|---|---|
| `merged-goes-dirty-stays` | The user already said what to keep and what to drop. Merged work, its remote copy and the named junk go; the dirty worktree and the old untracked file stay; the plan is shown before the first deletion. |
| `no-repo-scratch-only` | A session with no repository. Only the scratchpad is cleaned, the session's own files stay, and the repository next door is not touched or proposed. |
| `unmerged-waits-when-user-away` | The user cannot answer. Safe items go; the dirty worktree, the squash-merged branch, the remote branch and the untracked files wait, each listed with its reason. |

Run them from this skill's folder with `claude plugin eval . --allow-tools
Write,Edit,Bash --scaffold`, or by hand: build the fixture, give the prompt to
a session with the skill, and check the repository afterwards against the
graders. The prompts refer to `./fixture/...`, which is where `place-files.sh`
puts it.

A note on permissions: the apply step deletes things, and in auto mode the
app's classifier may refuse it. A run that stops and reports the plan when
refused is behaving as the skill asks; the state assertions will still fail
for that run, so read the transcript before counting it against the skill.
