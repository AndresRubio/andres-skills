#!/bin/sh
# The repository's check, run by the check-gate mod after a turn that changed code and by
# .githooks/pre-commit before a commit. It runs only the checks the current changes
# need: `npm run check` in plugins/issue-pipeline when that folder changed, and
# scripts/check-mods.sh for each mod folder that changed. A change to check-mods.sh or
# to a workflow runs every mod's check. With nothing changed it ends at once.
#   scripts/check.sh          checks what differs from origin/main plus the working tree
#   scripts/check.sh --all    runs every check
# Output follows the format check-gate reads: one `==> <step>` line per check, then
# `==> all checks passed` or `==> failed:` with one indented step per line.
set -u
cd "$(dirname "$0")/.." || exit 1

all=0
[ "${1:-}" = "--all" ] && all=1

# Everything that differs from where this branch left origin/main, committed or not,
# plus untracked files. Without origin/main, the working tree against HEAD.
changed() {
  base=$(git merge-base HEAD origin/main 2>/dev/null)
  {
    git diff --name-only "${base:-HEAD}" 2>/dev/null
    git ls-files --others --exclude-standard
  } | sort -u
}

pipeline=0
mods=''
mods_all=0
if [ "$all" -eq 1 ]; then
  pipeline=1
  mods_all=1
else
  for f in $(changed); do
    case $f in
      plugins/issue-pipeline/*) pipeline=1 ;;
      plugins/*/*)
        mod=${f#plugins/}
        mod=${mod%%/*}
        # A folder that is gone (a renamed or removed mod) has nothing to check.
        [ -d "plugins/$mod" ] || continue
        case " $mods " in *" $mod "*) ;; *) mods="$mods $mod" ;; esac
        ;;
      scripts/check-mods.sh|.github/workflows/*) mods_all=1 ;;
    esac
  done
fi

failed=''
ran=0

# Runs one step and records its name when it fails.
step() {
  ran=1
  echo "==> $1"
  if ! sh -c "$2"; then
    failed="$failed
  $1"
  fi
}

[ "$pipeline" -eq 1 ] && step "npm run check (plugins/issue-pipeline)" "cd plugins/issue-pipeline && npm run --silent check"
if [ "$mods_all" -eq 1 ]; then
  step "scripts/check-mods.sh" "scripts/check-mods.sh"
elif [ -n "$mods" ]; then
  step "scripts/check-mods.sh$mods" "scripts/check-mods.sh$mods"
fi

if [ -n "$failed" ]; then
  echo "==> failed:$failed"
  exit 1
fi
[ "$ran" -eq 0 ] && echo "nothing under plugins/ changed, so there is nothing to check"
echo "==> all checks passed"
