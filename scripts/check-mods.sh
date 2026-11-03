#!/bin/sh
# Validates and tests each mod: every plugins/<name>/ whose hooks/hooks.json
# names a hooks module. CI runs this on pull requests that touch plugins/.
# Name mods to check only those: scripts/check-mods.sh check-gate boe-guard
# validate runs without --strict, which would fail every mod for its missing icon.
set -u
cd "$(dirname "$0")/.." || exit 1

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
  if ! grep -q '"modules"' "$dir/hooks/hooks.json" 2>/dev/null; then
    # Without names this skips claude-pipeline. A named folder must be a mod.
    if [ $# -gt 0 ]; then
      echo "$name: not a mod (no hooks module in $dir/hooks/hooks.json)"
      failed="$failed $name"
    fi
    continue
  fi
  checked=$((checked + 1))

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
