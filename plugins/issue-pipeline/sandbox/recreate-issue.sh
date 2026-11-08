#!/usr/bin/env bash
# Replace a used sandbox issue with a fresh copy. It deletes nothing: the old issue is closed
# with a comment, any PR from it is closed, and the fixture map points at the new issue.
# Usage: sandbox/recreate-issue.sh <sandbox-dir> <fixture-file>
set -euo pipefail

sandbox=${1:?usage: recreate-issue.sh <sandbox-dir> <fixture-file>}
fixture=${2:?usage: recreate-issue.sh <sandbox-dir> <fixture-file>}
here=$(cd "$(dirname "$0")" && pwd)
cd "$sandbox"

old=$(node -e 'console.log(require(process.argv[1])[process.argv[2]] ?? "")' "$PWD/.pipeline-fixtures.json" "$fixture")
[ -n "$old" ] || { echo "no issue recorded for $fixture" >&2; exit 2; }

# Build the new issue first, so a failure here happens before anything is closed.
# fill-body.mjs fills the placeholders: {{PRIVATE_REPO}} becomes $SANDBOX_PRIVATE_REPO, default
# <owner>/pipeline-sandbox-private, and issue 15's {{ISSUE:..}}, {{PERMALINK:..}} and {{CI_RUN}}
# become links into this sandbox. Lookups only happen for a fixture that uses the placeholder.
f="$here/issues/$fixture"
title=$(sed -n '1s/^title: //p' "$f")
labels=$(sed -n '2s/^labels: //p' "$f")
body=$(mktemp)
trap 'rm -f "$body"' EXIT
node "$here/fill-body.mjs" "$f" "$PWD" > "$body"

prs=$(gh pr list --state open --limit 200 --json number,headRefName --jq ".[] | select(.headRefName | startswith(\"pipeline/$old-\") or . == \"pipeline/$old\") | .number")
for pr in $prs; do
  gh pr close "$pr" --comment "Superseded: test issue recreated."
done
gh issue close "$old" --comment "Superseded: test issue recreated from $fixture." >/dev/null

url=$(gh issue create --title "$title" --body-file "$body" --label "$labels")
number=${url##*/}
node -e 'const fs = require("fs"); const p = process.argv[1]; const m = JSON.parse(fs.readFileSync(p, "utf8")); m[process.argv[2]] = Number(process.argv[3]); fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n")' "$PWD/.pipeline-fixtures.json" "$fixture" "$number"
echo "recreated $fixture as #$number (was #$old)"
