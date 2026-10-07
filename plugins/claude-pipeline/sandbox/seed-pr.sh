#!/usr/bin/env bash
# Push a planted branch for a seeded PR fixture and open its PR, as a ship run would have.
# Usage: sandbox/seed-pr.sh <sandbox-dir> <fixture-file>    e.g. 12-archive-toggle.md
set -euo pipefail

sandbox=${1:?usage: seed-pr.sh <sandbox-dir> <fixture-file>}
fixture=${2:?usage: seed-pr.sh <sandbox-dir> <fixture-file>}
here=$(cd "$(dirname "$0")" && pwd)
name=${fixture%.md}
src="$here/prs/$name"
[ -d "$src" ] || { echo "no planted PR at $src" >&2; exit 2; }
cd "$sandbox"

number=$(node -e 'console.log(require(process.argv[1])[process.argv[2]] ?? "")' "$PWD/.pipeline-fixtures.json" "$fixture")
[ -n "$number" ] || { echo "no issue recorded for $fixture; create it first" >&2; exit 2; }
slug=${name#*-}
branch="claude/$number-$slug"

git fetch origin --prune
git switch -c "$branch" origin/main
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R "$src/." "$tmp/"
if [ -d "$tmp/docs/pipeline/KEY" ]; then mv "$tmp/docs/pipeline/KEY" "$tmp/docs/pipeline/$number"; fi
# macOS sed: `-i ''`. On Linux use `sed -i` without the empty argument; this script runs on a Mac.
find "$tmp" -type f -exec sed -i '' -e "s/{{KEY}}/$number/g" -e "s/{{NUMBER}}/$number/g" {} +
body="$tmp/pr-body.md"
cp -R "$tmp/." .
rm -f pr-body.md
git add -A
printf 'feat: seeded PR for %s (#%s)\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n' "$name" "$number" > "$tmp/msg.txt"
git commit -q -F "$tmp/msg.txt"
git push -u origin "$branch"
title=$(sed -n '1s/^title: //p' "$here/issues/$fixture")
gh pr create --base main --head "$branch" --title "$title (#$number)" --body-file "$body"
git switch main
