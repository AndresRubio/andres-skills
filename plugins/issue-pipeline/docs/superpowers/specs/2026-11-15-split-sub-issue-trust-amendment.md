# Split sub-issue trust amendment (2026-11-15)

Amendment to `2026-09-24-issue-pipeline-design.md`, for issue-pipeline 0.3.9. Status: approved by the owner on 2026-11-17, with the calls listed at the end.

## Why

The first split in Actions ran on 2026-11-13. Issue 4 of the private sandbox ("Make the whole app bilingual") was graded `too-big` in run 43519533724, and the session created sub-issues 28, 29 and 30. None of them started, and none will. GitHub gives their author, `claude[bot]`, the author association `NONE`, and two checks refuse such issues:

- the route of `pipeline-ship` (`laneTarget` in `lane.mjs`), which skipped all three label events with "issue author is not trusted";
- eligibility (`checkEligibility` in `eligibility.mjs`), which the sweep and stage 0 both run.

The design disagrees with itself here. §6.1 makes an issue eligible only when "you or a collaborator" created it. §5.2 has the split create sub-issues labelled `pipeline`, the state diagram ends a split with "children become eligible", and the Phase 2a acceptance row expects issue 4 to split with no human action.

The same run showed a timing problem. Stage 3 creates each sub-issue with the `pipeline` label already on it, and only afterwards links it to its parent and chains it behind the previous one. On issue 29 the label landed at 22:31:58 and the "blocked by 28" link at 22:32:00. If only the trust check were fixed, the label event of a later sub-issue could start a run before the chain exists.

## Goals

- After a split in automatic mode on GitHub, the first sub-issue starts from its own label event, with nothing from the owner.
- Each later sub-issue starts once the one before it has closed, from the sweep that `pipeline-ready` runs after each merge.
- A sub-issue's trust traces back to a trusted parent and to the pipeline's own split comment on that parent.

## Non-goals

- Making the scheduled sweep run on time. On 2026-11-13 GitHub ran it about every 6 to 8 hours on the sandboxes, against the configured 30 minutes.
- Linear. Its sub-issues are created with a workspace member's key and already pass §6.1.
- Trusting anything else a pipeline bot writes.

## Anti-goals

- A sub-issue that a pipeline bot wrote for someone other than the pipeline starts a run.
- A later sub-issue starts while an earlier one is still open.

## Approaches

A. Parent link. Trust an issue written by a pipeline bot when GitHub lists it as a sub-issue of a trusted issue. It costs one extra API call. Any sub-issue the Claude App adds under a trusted issue and labels `pipeline` would count, whoever asked for it.

B. Parent link and split comment. Everything in A, and the parent's latest pipeline `split` comment must name the issue on a fixed last line. It costs two extra API calls, a fixed line format and a read-back check after posting. The owner picked B on 2026-11-14, so that trust rests on the grade that made the issue.

Neither approach stops someone who can make the Claude App write whatever they want, since they could write the split comment too. B also rules out the App adding `pipeline` sub-issues under a trusted issue for some other reason.

Two more were dropped early. Trusting every issue a pipeline bot writes is too loose: any workflow that uses the same GitHub App, such as an `@claude` assistant, writes as `claude[bot]`. Creating the sub-issues with the owner's `PIPELINE_TOKEN` would make them `OWNER` issues, but the ship session would then hold the owner's token, which it does not have today.

## The rule

An issue's author is trusted when its author association is `OWNER`, `MEMBER` or `COLLABORATOR`, as today, or when all of these hold:

1. Its author is a pipeline bot, one of `PIPELINE_BOTS` in `lock.mjs` (`claude[bot]` and `github-actions[bot]`).
2. GitHub names a parent for it (the issue's `parent_issue_url`), and the parent's own author association is trusted. A parent written by a bot does not vouch, so trust passes down one level only.
3. The parent's latest pipeline comment of kind `split` (a marker comment for which `isPipelineComment` is true) ends with the split line, and the line lists this issue's number.

The split line reads `Split into: 28, 29, 30`: the sub-issue numbers in slice order, joined by ", ", with no backticks, no bold and nothing after it. It plays the part the `Waiting for:` line plays in a `deferred` comment.

One function decides this for every caller. It replaces the author check in the three places that test an issue's author:

- the route for `issues: labeled`, with the `pipeline` and `pipeline-go` labels;
- the route for `issue_comment`, so that the owner's reply on a parked sub-issue resumes it;
- eligibility, used by the sweep and by stage 0.

The route's check on who added the label stays. The session adds the label, and the session's account is the sub-issue's author, so the check passes. The `readable` check in `runs.mjs` already accepts pipeline-bot authors and stays as it is.

## Where the data comes from

When the event's issue was written by a pipeline bot, the `lane-target` command fetches that issue from the API, which gives its `parent_issue_url` without relying on the webhook payload to carry it. If the URL names an issue of the same repository, the command fetches that parent and its comments and passes what it found to `laneTarget`, which stays a pure function. A parent in another repository is never fetched and never vouches. `fetchIssue` does the same, so the normalized issue carries the parent's number, its author association and the numbers on its latest split line. Other issues cost no extra calls.

## The new order of a split

Stage 3, too-big, in automatic mode. In interactive mode, "create the sub-issues" does the same.

1. Append "## Proposed split" to grade.md.
2. Create each sub-issue under NUMBER without the `pipeline` label. It still gets `needs-local` if the parent has it.
3. Chain them with blocked-by, each behind the one before.
4. Post the `split` comment on the parent: grade.md, the list of created issues, and the split line as the last line.
5. Read the line back with a new CLI command modelled on `waiting-for --repo --issue --expect`. It fetches the parent and retries once if the numbers differ. If it fails, hard rule 7 applies.
6. Add `pipeline` to each sub-issue, first to last.
7. Remove `pipeline-working` from the parent, delete `docs/pipeline/<KEY>` and the empty worktree, and stop, as today.

Every label event then arrives after the links, the chain and the split comment exist.

The route also refuses an issue whose event shows it blocked by an open issue (`issue_dependencies_summary.blocked_by` above 0). Without that, labelling sub-issues 2 onwards would start a ship job for each one, and each job would run Claude as far as stage 0 only to stop there. The builder confirms on a sandbox that `blocked_by` counts only open blockers.

## Spec changes

- §5.2, "On too-big": sub-issues are created without `pipeline` and get it after the split comment is posted and read back.
- §6.1, second bullet: add the sub-issue case and point to this amendment.
- The tracker adapter's `create-sub-issue` stays as it is. It takes labels, and stage 3 now passes only `needs-local`.
- The tracker adapter's `add-labels` takes an optional issue number, since today it labels only `$NUMBER` and step 6 labels the sub-issues.

## Tests

Each test is written first and seen to fail, as in 0.3.8.

- The trust function: a trusted association, and a bot author whose trusted parent's split line lists it. Then each way it fails: no parent, an untrusted parent, a parent written by a bot, no split comment, a split comment without the line, a line that leaves the issue out, an older split comment that lists it while the latest does not, and an author outside `PIPELINE_BOTS` with a parent.
- The route for both events, including the refusal of a blocked issue.
- Eligibility for the same cases.
- `fetchIssue` fetches the parent only for a bot-written issue that has one.
- The read-back command, tested the way `waiting-for` is.
- The stage 3 text lists the steps in the new order (`test/skill-wording.test.mjs`, where tests that pin skill wording live).

## Rollout

Version 0.3.9, with the three version fields equal. Sub-issues 28, 29 and 30 of the private sandbox have no split line, so they stay untrusted on 0.3.9 and nothing starts by itself when the sandbox moves to it. To see the whole path, with the owner's word for each step: close 28 to 30 as not planned, take `pipeline` off issue 4 and put it back, and expect a new split whose first sub-issue starts from its label and whose later ones start after each merge.

## Calls made in this design

The owner did not decide these. Each can be changed before the plan is written.

- A parent written by a bot does not vouch for its sub-issues.
- Both accounts in `PIPELINE_BOTS` can author a trusted sub-issue, since it is the set pipeline comments already use.
- Only the parent's latest split comment counts.
- The route refuses an issue that is blocked by an open issue.
- The trust function sits next to `TRUSTED` in `lock.mjs`, and the read-back command is named `split-into`.
- This file follows the name pattern of the token-leaks amendment instead of the `-design.md` ending.

## Left to the builder

Function names, error texts, where the split-line parser lives, and how the tests fake the route's extra fetch.
