#!/usr/bin/env bash
# Build a throwaway repository that looks like a project after a few Claude
# Code sessions, so that the cleanup skill can be tested without touching real
# work. Everything lands under DEST (created if missing):
#
#   DEST/origin.git         bare remote the repo pushes to (no network needed)
#   DEST/demo-app           the project, on main
#     .claude/worktrees/merged-feature   claude/merged-feature, merged into main, also on origin
#     .claude/worktrees/wip-report       claude/wip-report, 1 commit ahead + notes.md uncommitted
#     .claude/worktrees/detached-scratch detached HEAD at main, clean
#     branch claude/old-spike            merged into main, no worktree
#     branch claude/squash-merged        two commits squash-merged into main (unless --no-squash)
#     tmp-output.log, cleanup-workspace/ untracked files written "this session"
#     old-draft.txt                      untracked file dated a week ago
#   DEST/scratchpad         three files, the session's scratch dir
#   DEST/notes              a plain folder with no git, two files
#
# Usage: make_fixture.sh DEST [--no-squash]

set -euo pipefail

DEST="${1:?usage: make_fixture.sh DEST [--no-squash]}"
WITH_SQUASH=1
[[ "${2:-}" == "--no-squash" ]] && WITH_SQUASH=0

export GIT_AUTHOR_NAME="Fixture" GIT_AUTHOR_EMAIL="fixture@example.com"
export GIT_COMMITTER_NAME="Fixture" GIT_COMMITTER_EMAIL="fixture@example.com"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

rm -rf "$DEST"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

git init -q --bare -b main "$DEST/origin.git"
git init -q -b main "$DEST/demo-app"
cd "$DEST/demo-app"
git remote add origin "$DEST/origin.git"

cat > README.md <<'EOF'
# demo-app
A small project used to test the cleanup skill.
EOF
mkdir -p src
printf 'def main():\n    print("hello")\n' > src/app.py
printf '.claude/worktrees/\n__pycache__/\n' > .gitignore
git add -A && git commit -qm "Initial project"
git push -q -u origin main
git remote set-head origin main

WT="$DEST/demo-app/.claude/worktrees"
mkdir -p "$WT"

# merged-feature: worktree + branch, merged with a merge commit, pushed to origin.
git worktree add -q -b claude/merged-feature "$WT/merged-feature" main
( cd "$WT/merged-feature" && echo "feature = True" > src/feature.py && git add -A \
  && git commit -qm "Add feature flag" && git push -q -u origin claude/merged-feature )
git merge -q --no-ff -m "Merge claude/merged-feature" claude/merged-feature
git push -q origin main

# old-spike: branch merged long ago, no worktree left.
git branch -q claude/old-spike main

# squash-merged: two commits reached main as one squash. Neither ancestry nor
# `git cherry` (patch equivalence, which only matches one-to-one) can prove the
# merge, so a careful cleanup has to leave this branch to the user.
if [[ $WITH_SQUASH -eq 1 ]]; then
  git branch -q claude/squash-merged main
  git checkout -q claude/squash-merged
  echo "rate = 0.5" > src/rates.py && git add -A && git commit -qm "Add rates module"
  echo "limit = 10" >> src/rates.py && git add -A && git commit -qm "Add rate limit"
  git checkout -q main
  git merge -q --squash claude/squash-merged >/dev/null && git commit -qm "Add rates module (squash)"
  git push -q origin main
fi

# wip-report: unmerged commit plus an uncommitted file.
git worktree add -q -b claude/wip-report "$WT/wip-report" main
( cd "$WT/wip-report" && mkdir -p reports && echo "# Weekly report" > reports/weekly.md \
  && git add -A && git commit -qm "Start weekly report" \
  && echo "- remember to add the chart" > notes.md )

# detached-scratch: a detached worktree at main, nothing of its own.
git worktree add -q --detach "$WT/detached-scratch" main

# Untracked leftovers in the main checkout.
printf 'server started\nrequest ok\n' > tmp-output.log
mkdir -p cleanup-workspace/iteration-1 && echo '{}' > cleanup-workspace/iteration-1/run.json
echo "draft from last week" > old-draft.txt
touch -t "$(date -v-7d +%Y%m%d%H%M 2>/dev/null || date -d '7 days ago' +%Y%m%d%H%M)" old-draft.txt

# Scratchpad and a git-less folder.
mkdir -p "$DEST/scratchpad"
echo "x,y" > "$DEST/scratchpad/data.csv"
echo "print(1)" > "$DEST/scratchpad/probe.py"
mkdir -p "$DEST/scratchpad/build" && echo "o" > "$DEST/scratchpad/build/out.o"

mkdir -p "$DEST/notes"
echo "# Meeting notes" > "$DEST/notes/meeting.md"
echo "todo: send summary" > "$DEST/notes/todo.txt"

echo "fixture ready at $DEST"
