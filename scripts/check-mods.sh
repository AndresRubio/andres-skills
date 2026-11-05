#!/bin/sh
# Validates and tests each mod: every plugins/<name>/ whose hooks/hooks.json
# names a hooks module, or that has Python tests at tests/test_*.py next to
# command hooks. CI runs this on pull requests and pushes to main that touch
# plugins/.
# Name mods to check only those: scripts/check-mods.sh check-gate boe-guard
# validate runs without --strict, which would fail every mod for its missing icon.
set -u
cd "$(dirname "$0")/.." || exit 1

# `claude plugin update` goes by the version number, so a hooks change that keeps
# the version never reaches installed copies. Versions are compared against
# CHECK_MODS_BASE (CI sets it on a push to main), else where this branch left
# origin/main.
base=${CHECK_MODS_BASE:-$(git merge-base HEAD origin/main 2>/dev/null)}
if ! git cat-file -e "${base:-none}^{commit}" 2>/dev/null; then
  echo "Can't find a commit to compare mod versions against (${base:-no origin/main}). Run: git fetch origin main"
  exit 1
fi

version_of() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n 1; }

if [ $# -gt 0 ]; then
  dirs=''
  for name in "$@"; do dirs="$dirs plugins/$name"; done
else
  dirs=$(ls -d plugins/*/ | sed 's:/$::')
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT
failed=''
checked=0

for dir in $dirs; do
  name=${dir#plugins/}
  if grep -q '"modules"' "$dir/hooks/hooks.json" 2>/dev/null; then
    kind=module
    watched="$dir/hooks"
  elif [ -f "$dir/hooks/hooks.json" ] && ls "$dir"/tests/test_*.py >/dev/null 2>&1; then
    kind=python
    # This kind also ships a skill, and installed copies only update on a version bump.
    watched="$dir/hooks $dir/skills"
  else
    # Without names this skips claude-pipeline. A named folder must be a mod.
    if [ $# -gt 0 ]; then
      echo "$name: not a mod (no hooks module in $dir/hooks/hooks.json and no Python tests)"
      failed="$failed $name"
    fi
    continue
  fi
  checked=$((checked + 1))

  # $watched is split on purpose: it holds one or two folders.
  if ! git diff --quiet "$base" -- $watched; then
    before=$(git show "$base:$dir/.claude-plugin/plugin.json" 2>/dev/null | version_of)
    now=$(version_of <"$dir/.claude-plugin/plugin.json")
    # A mod that is new since the base has no installed copies to reach.
    if [ -n "$before" ] && [ "$before" = "$now" ]; then
      echo "$name: FAILED, its hooks changed but its version is still $now, so installed copies won't update. Bump the version in plugin.json."
      failed="$failed $name"
      continue
    fi
  fi

  if grep -rnE '@ts-(ignore|nocheck|expect-error)' "$dir/hooks" "$dir/tests" 2>/dev/null; then
    echo "$name: FAILED, a @ts- comment turns off type checking (docs/mods.md, rule 3)"
    failed="$failed $name"
    continue
  fi

  if claude plugin validate "$dir" >"$log" 2>&1; then
    echo "$name: validate passed"
  else
    cat "$log"
    echo "$name: validate FAILED"
    failed="$failed $name"
    continue
  fi

  if [ "$kind" = python ]; then
    if python3 -m unittest discover -s "$dir/tests" -p 'test_*.py' >"$log" 2>&1; then
      echo "$name: tests $(grep -E '^Ran ' "$log")"
    else
      cat "$log"
      echo "$name: tests FAILED"
      failed="$failed $name"
    fi
    continue
  fi

  if claude plugin test "$dir" >"$log" 2>&1; then
    echo "$name: tests $(grep -E '^ *[0-9]+ (pass|fail)$' "$log" | tr -s ' \n' ' ' | sed 's/^ //;s/ $//')"
  else
    cat "$log"
    echo "$name: tests FAILED"
    failed="$failed $name"
  fi
done

if [ -n "$failed" ]; then
  echo "Failed:$failed"
  exit 1
fi
if [ "$checked" -eq 0 ]; then
  echo "No mods found under plugins/"
  exit 1
fi
echo "All $checked mods passed"
