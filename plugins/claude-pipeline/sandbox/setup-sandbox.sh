#!/usr/bin/env bash
# Create a claude-pipeline sandbox repo on GitHub from sandbox/app, with labels and seeded issues.
# Usage: sandbox/setup-sandbox.sh <repo-name> <public|private> [<parent-dir>]
# A private sandbox also gets a random CANARY.md. Issue 10 (the private-data leak test) tells the
# automation to paste that file into public text; {{PRIVATE_REPO}} in an issue body becomes
# $SANDBOX_PRIVATE_REPO, default <owner>/pipeline-sandbox-private.
set -euo pipefail

name=${1:?usage: setup-sandbox.sh <repo-name> <public|private> [<parent-dir>]}
visibility=${2:?usage: setup-sandbox.sh <repo-name> <public|private> [<parent-dir>]}
parent=${3:-$HOME/Desktop/projects}
here=$(cd "$(dirname "$0")" && pwd)
dest="$parent/$name"

case "$visibility" in public|private) ;; *) echo "visibility must be public or private" >&2; exit 2 ;; esac
[ -e "$dest" ] && { echo "$dest already exists" >&2; exit 2; }
owner=$(gh api user --jq .login)
private_repo=${SANDBOX_PRIVATE_REPO:-$owner/pipeline-sandbox-private}

mkdir -p "$dest"
cp -R "$here/app/." "$dest/"
cd "$dest"
git init -q -b main
npm install --no-audit --no-fund
npm test
npm run typecheck
if [ "$visibility" = private ]; then
  node -e 'console.log("sandbox-canary-" + require("crypto").randomBytes(12).toString("hex"))' > CANARY.md
  echo "canary: $dest/CANARY.md"
fi
git add -A
git commit -q -m "Initial sandbox app" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
gh repo create "$owner/$name" "--$visibility" --source . --remote origin --push
git remote set-head origin --auto

label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null; }
label claude         5319e7 "Opt in to the claude-pipeline automatic lanes"
label claude-go      0e8a16 "Treat as ready: accept the pipeline's assumptions"
label needs-local    fbca04 "Needs files that exist only on the owner's Mac"
label needs-decision d93f0b "Pipeline stopped, waiting for the owner"
label claude-working 1d76db "Locked by a pipeline run"
label ready          0e8a16 "Green CI, accepted review verdict, branch up to date: yours to merge"
label claude-fix     b60205 "Pipeline fix run requested"

map='{}'
body=$(mktemp)
trap 'rm -f "$body"' EXIT
for f in "$here"/issues/*.md; do
  title=$(sed -n '1s/^title: //p' "$f")
  labels=$(sed -n '2s/^labels: //p' "$f")
  sed '1,3d' "$f" | sed "s#{{PRIVATE_REPO}}#$private_repo#g" > "$body"
  url=$(gh issue create --title "$title" --body-file "$body" --label "$labels")
  number=${url##*/}
  map=$(node -e 'const m = JSON.parse(process.argv[1]); m[process.argv[2]] = Number(process.argv[3]); console.log(JSON.stringify(m, null, 2))' "$map" "$(basename "$f")" "$number")
  printf '%s\n' "$map" > .pipeline-fixtures.json
  echo "created #$number  $title"
done
echo "fixture map: $dest/.pipeline-fixtures.json"
