# Tracker adapter: GitHub

Every operation uses `gh`, authenticated as the account running this session. `REPO` is `owner/name` and `NUMBER` is the issue number. If any command here fails, stop (hard rule 7).

In the commands below, `<name>` is a placeholder: write the literal value in its place. `$NAME` variables come from the run's `vars.sh` (see SKILL.md).

## read-issue

`node "$PIPELINE" issue "$NUMBER" --repo "$REPO" > "$RUN_DIR/issue.json"`

Fields: `number`, `id` (database id), `nodeId`, `title`, `body`, `state`, `url`, `author`, `authorAssociation`, `isPullRequest`, `labels[]`, `openBlockedBy[]`, `openSubIssues[]`, `comments[]` (`id`, `author`, `authorAssociation`, `body`, `createdAt`, `marker`). A comment's `marker` is non-null when the pipeline posted it.

## post-comment

Takes a marker kind and a body.

1. `node "$PIPELINE" marker <kind> > "$RUN_DIR/comment.md"`: every pipeline comment starts with this line.
2. Append a blank line and the body to `$RUN_DIR/comment.md`.
3. `gh issue comment "$NUMBER" --repo "$REPO" --body-file "$RUN_DIR/comment.md"`

## add-labels

`gh issue edit "$NUMBER" --repo "$REPO" --add-label "<label>[,<label>…]"`

## remove-labels

`gh issue edit "$NUMBER" --repo "$REPO" --remove-label "<label>[,<label>…]"`

## set-in-progress

GitHub issues have no status field; the `claude-working` label shows the issue is in progress. Nothing to do.

## create-issue

Takes a title, a body file and optional labels.

`gh issue create --repo "$REPO" --title "<title>" --body-file "<file>" [--label "<labels>"]` prints the new issue's URL. The last path segment is its number.

## create-sub-issue

Takes the parent number, a title, a body file and labels.

1. Create the child with create-issue, and note its number as <child>.
2. Link it in one command: `gh api -X POST "repos/$REPO/issues/<parent>/sub_issues" -F sub_issue_id="$(gh api "repos/$REPO/issues/<child>" --jq .id)"`

## add-blocked-by

Takes an issue number and the number of the issue that blocks it.

`gh api -X POST "repos/$REPO/issues/<issue>/dependencies/blocked_by" -F issue_id="$(gh api "repos/$REPO/issues/<blocker>" --jq .id)"`

## open-claude-pr-count

`node "$PIPELINE" pr-count --repo "$REPO"` prints `{"count": N}`.

## create-pr

Takes a title, a body file and optional labels. The base branch name is `BASE_REF` without its `origin/` prefix.

`gh pr create --repo "$REPO" --base "<base branch>" --head "$BRANCH" --title "<title>" --body-file "<file>" [--label "<labels>"]`

The body must contain `Fixes #<NUMBER>` so GitHub closes the issue on merge. The command prints the PR URL.
