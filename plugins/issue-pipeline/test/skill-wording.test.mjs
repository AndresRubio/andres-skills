import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { read, section, step } from './helpers/skill.mjs';

// Wording pins for the ship and review skills. Each test here checks that a particular sentence,
// phrase or command spelling is present in a skill file: the instruction a review or a fix wave
// asked for. They catch a rewording that drops an instruction, and that is all they catch. Whether
// the agent follows the instruction is only shown by a sandbox run. skill-structure.test.mjs and
// review-skill.test.mjs hold the tests that check the skill text against the code and against itself.

test('SKILL.md keeps variables in vars.sh', () => {
  const text = read('SKILL.md');
  assert.match(text, /\. '<RUN_DIR>\/vars\.sh' &&/);
  assert.match(text, /printf "set -u\\n/);
  assert.match(text, /'\\''/);
  const wt = text.match(/`[^`]*worktree-remove-if-empty[^`]*`/);
  assert.ok(wt, 'worktree-remove-if-empty command not found');
  assert.match(wt[0], /^`\. '<RUN_DIR>\/vars\.sh' && node "\$PIPELINE" worktree-remove-if-empty/);
});

test('interactive mode posts grade and assumptions comments (B1)', () => {
  const grade = read('stages/03-grade.md');
  const gradeInteractive = grade.split('## Interactive mode')[1] ?? '';
  assert.match(gradeInteractive, /kind `grade`/, '03-grade.md Interactive mode must post kind `grade`');

  const spec = read('stages/04-spec.md');
  const specSteps = spec.split('## Steps')[1]?.split('\n## ')[0] ?? '';
  assert.match(specSteps, /kind `assumptions`/, '04-spec.md Steps must post kind `assumptions`');
  const specAutomatic = spec.split('## Automatic mode')[1]?.split('\n## ')[0] ?? '';
  assert.doesNotMatch(specAutomatic, /kind `assumptions`/, '04-spec.md must not post kind `assumptions` only under Automatic mode');
});

test('a stopped run consumes pipeline-go instead of looping (B2)', () => {
  const skill = read('SKILL.md');
  const stop = skill.split('## Stop procedure')[1]?.split('\n## ')[0] ?? '';
  assert.match(stop, /remove-labels.*pipeline-go|pipeline-go.*remove-labels/s, 'stop procedure must remove pipeline-go');
  assert.match(stop, /accepts one set of recommendations/, 'stop procedure must explain that pipeline-go is single-use');

  const grade = read('stages/03-grade.md');
  assert.match(grade, /Reply with the values to resume/, '03-grade.md must offer a values-only reply when nothing but values is missing');
});

test('resolve and finish guard against a PR that already exists (B3)', () => {
  const resolve = read('stages/00-resolve.md');
  assert.match(resolve, /existing-prs\.json/);
  assert.match(resolve, /startswith\("pipeline\/<KEY>-"\)/);

  const finish = read('stages/09-finish.md');
  assert.match(finish, /gh pr list --repo "\$REPO" --head "\$BRANCH" --state open/);
  assert.match(finish, /reuse it as PR_URL|don't create another/);
});

test('set -u safe defaults for CI and ISSUE_PIPELINE_LANE (B6)', () => {
  assert.match(read('stages/00-resolve.md'), /\$\{ISSUE_PIPELINE_LANE:-github\}/);
  assert.match(read('stages/fix.md'), /\$\{ISSUE_PIPELINE_LANE:-github\}/);
  assert.match(read('stages/01-isolate.md'), /\$\{CI:-\}/);
});

test('RUN_DIR is created under the pipeline home (B7)', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /ISSUE_PIPELINE_HOME:-\$HOME\/\.issue-pipeline/);
  assert.match(skill, /runs\/run-XXXXXX/);
  assert.match(skill, /rebuild RUN_DIR's inputs/);
});

test('stage 2 research runs as a foreground subagent (B8)', () => {
  const research = read('stages/02-research.md');
  assert.match(research, /foreground subagent/);
});

test('fix mode checks config, forked PRs and the fix-run cap with the trust flags (B9)', () => {
  const fix = read('stages/fix.md');
  assert.match(fix, /`enabled` false: stop and change nothing/);
  assert.match(fix, /Linear adapter arrives in Phase 3/);
  assert.match(fix, /isCrossRepository/);
  assert.match(fix, /PRs from forks aren't worked by the pipeline/);
  assert.match(fix, /--slurp/);
  assert.match(fix, /pipeline: true`? ?and kind `lock`|kind `lock`.*pipeline: true/s);
});

test('the trust flags gate automatic-mode actions (B10)', () => {
  const skill = read('SKILL.md');
  const rules = skill.split('## Hard rules')[1]?.split('\n## ')[0] ?? '';
  assert.match(rules, /trusted: true/);
  assert.match(rules, /pipeline: true/);

  const isolate = read('stages/01-isolate.md');
  assert.match(isolate, /pipeline: true/);
  assert.match(isolate, /trusted: true/);

  const grade = read('stages/03-grade.md');
  assert.match(grade, /pipeline: true/);
  assert.match(grade, /trusted: true/);
});

test('smaller prose fixes are in place (B11)', () => {
  assert.match(read('stages/06-build.md'), /commit-msg\.txt/);
  assert.match(read('stages/06-build.md'), /git commit -F "\$RUN_DIR\/commit-msg\.txt"/);
  assert.match(read('stages/00-resolve.md'), /source\.txt/);
  const verify = read('stages/07-verify.md');
  assert.match(verify, /node "\$PIPELINE" preview-start --config-file "\$RUN_DIR\/config\.json"/);
  assert.match(verify, /node "\$PIPELINE" preview-stop --pid-file "\$RUN_DIR\/preview\.pid"/);
  assert.match(read('stages/08-review.md'), /confession-box skill if it's installed/);
  assert.match(read('stages/10-report.md'), /git worktree remove --force <path>/);
});

test('hard rule 3 lists what may share a command with a push (16a fix)', () => {
  const rules = read('SKILL.md').split('## Hard rules')[1]?.split('\n## ')[0] ?? '';
  const rule3 = rules.match(/^3\. \*\*.*$/m)?.[0] ?? '';
  assert.match(rule3, /after sourcing vars\.sh, with only `cd`, `git add`, `git commit` and `git status` in the same command/);
  assert.doesNotMatch(rule3, /as its own command/);
});

test('Setup says what a pushing command may contain, and stage 6 keeps the ledger copy out of it (16a round 2)', () => {
  const setup = read('SKILL.md').match(/^2\. \*\*Shell variables.*$/m)?.[0] ?? '';
  assert.match(setup, /A command that pushes contains only that prefix, `git add`, `git commit`, `git status` and the push itself/);
  assert.match(setup, /do anything else \(copying files, recording a SHA\) in a separate command/);

  const build = read('stages/06-build.md');
  assert.match(build, /under "## SDD ledger" \(the file-writing tool, or a command of its own\)[^\n]*then commit and push in a separate command: `git add [^`]* && git commit [^`]* && git push origin "\$BRANCH"`/);
  assert.doesNotMatch(build, /"## SDD ledger", commit, and push/);
});

test('stage 9 pushes as its own command and records the SHA in a separate one (16a fix)', () => {
  const step1 = read('stages/09-finish.md').match(/^1\. .*$/m)?.[0] ?? '';
  assert.match(step1, /push with `git push -u origin "\$BRANCH"` as its own command/);
  assert.match(step1, /as a separate command, record the SHA: `echo "SHA='\$\(git rev-parse HEAD\)'" >> "\$RUN_DIR\/vars\.sh"`/);
});

test('hard rule 3 names the run guard hook and the stop procedure (16a)', () => {
  const rules = read('SKILL.md').split('## Hard rules')[1]?.split('\n## ')[0] ?? '';
  const rule3 = rules.match(/^3\. \*\*.*$/m)?.[0] ?? '';
  assert.match(rule3, /run guard/);
  assert.match(rule3, /plugin hook/);
  assert.match(rule3, /stop procedure/);
  assert.match(rule3, /move the text into a file/);
});

test('hard rule 7 only runs the stop procedure once the lock is taken (R3)', () => {
  const rules = read('SKILL.md').split('## Hard rules')[1]?.split('\n## ')[0] ?? '';
  const rule7 = rules.match(/^7\. \*\*.*$/m)?.[0] ?? '';
  assert.match(rule7, /If this run has already taken the lock/);
  assert.match(rule7, /before the lock, just stop, changing nothing on the tracker/);
});

test('the existing-PR gate is paginated and matches the slug-less branch too (R4)', () => {
  const resolve = read('stages/00-resolve.md');
  assert.match(resolve, /--limit 100/);
  assert.match(resolve, /headRefName == "pipeline\/<KEY>"/);
  assert.match(resolve, /startswith\("pipeline\/<KEY>-"\)/);
});

test('an existing PR is reused, not treated as a shortcut to stage 10 (R5)', () => {
  const finish = read('stages/09-finish.md');
  assert.doesNotMatch(finish, /go straight to stage 10/);
  assert.match(finish, /reuse it, skipping only the create step/);
  const automatic = finish.split('## Automatic mode')[1]?.split('\n## ')[0] ?? '';
  assert.match(automatic, /continue with the remaining steps/);
});

test('stage 10 clears pipeline-go and cleans up RUN_DIR (R6)', () => {
  const report = read('stages/10-report.md');
  assert.match(report, /remove-labels.*pipeline-working.*pipeline-go|pipeline-go.*if the issue has it/);
  assert.match(report, /rm -rf "\$RUN_DIR"/);
});

test('fix mode writes source.txt like stage 0, and inline comments use the REST field names (R7)', () => {
  const fix = read('stages/fix.md');
  assert.match(fix, /source\.txt/);
  assert.match(fix, /author_association/);
  assert.match(fix, /user\.login/);
});

test('stage 0 counts runs before eligibility, then recounts after the lock and before needs-decision is removed (16c)', () => {
  const resolve = read('stages/00-resolve.md');
  const steps = section(resolve, 'Steps');
  const step7 = step(steps, 7);
  assert.match(step7, /tracker:active-runs/);
  assert.match(step7, /--active-runs-file "\$RUN_DIR\/active-runs\.json"/);
  assert.doesNotMatch(step7, /--open-pipeline-prs/);

  const lockAt = steps.indexOf('kind `lock`');
  const recountAt = steps.indexOf('--expect-locked');
  const needsDecisionAt = steps.search(/tracker:remove-labels` `needs-decision`/);
  assert.ok(lockAt > 0 && recountAt > lockAt, 'the recount must come after the lock comment');
  assert.ok(needsDecisionAt > recountAt, 'needs-decision must be removed only after the recount');

  const step11 = step(steps, 11);
  assert.match(step11, /--expect-locked/);
  assert.match(step11, /`self\.lockedAt` is still `null`/);
  assert.match(step11, /hard rule 7/);
  assert.match(step11, /`admitted` is false/);
  assert.match(step11, /kind `deferred`/);
  assert.match(step11, /Deferred: <n> runs are ahead of this one \(<label for each key in ahead>\) and `maxParallel` is <M>\. A later run picks it up once a slot frees: the sweep, the next poll, or `\/ship #<NUMBER>`\./);
  assert.match(step11, /<n> runs are ahead and `maxParallel` is <M>; continuing because you started this run\./);
  assert.ok(step11.indexOf('kind `deferred`') < step11.indexOf('tracker:remove-labels` `pipeline-working`'), 'the back-off posts deferred before releasing the label');
  assert.ok(step11.indexOf('tracker:remove-labels` `pipeline-working`') < step11.indexOf('rm -rf "$RUN_DIR"'), 'the back-off removes RUN_DIR last, as stage 10 does');
  assert.match(step11, /PR #<n>` for `PR-<n>`/);

  assert.match(step(steps, 12), /tracker:set-in-progress/);
  assert.match(section(resolve, 'Outputs'), /active-runs/);
});

test('fix mode takes the lock like stage 0 steps 10 and 12, and posts a report on the issue before releasing it (16c)', () => {
  const fix = read('stages/fix.md');
  assert.match(fix, /stage 0 steps 10 and 12/);
  assert.match(fix, /without step 11's recount/);
  const step11 = step(section(fix, 'Steps'), 12);
  const reportAt = step11.indexOf('kind `report`');
  const releaseAt = step11.indexOf('tracker:remove-labels` `pipeline-working`');
  assert.ok(reportAt >= 0 && releaseAt > reportAt, `fix.md step 12 must post a report before removing pipeline-working:\n${step11}`);
  assert.match(step11, /Fix run finished on PR #<PR>\./);
});

test("SKILL.md's interactive stop posts a report before removing pipeline-working (16c)", () => {
  const stop = section(read('SKILL.md'), 'Stop procedure');
  const interactive = stop.match(/^2\. \*\*Interactive mode:\*\*.*$/m)?.[0] ?? '';
  const reportAt = interactive.indexOf('kind `report`');
  const releaseAt = interactive.indexOf('tracker:remove-labels` `pipeline-working`');
  assert.ok(reportAt >= 0 && releaseAt > reportAt, interactive);
  assert.match(interactive, /Run ended by the user at stage <N>\./);
});

test('stage 2 fetches, gathers in-flight evidence, and judges the three relations (16c)', () => {
  const research = read('stages/02-research.md');
  assert.match(research, /git fetch origin --prune/);
  assert.match(research, /active-runs\.json/);
  assert.match(research, /\$RUN_DIR\/inflight\//);
  for (const relation of ['builds-on', 'same-code', 'same-decision']) assert.match(research, new RegExp(`\`${relation}\``));
  assert.match(research, /In-flight overlap/);
  assert.doesNotMatch(research, /\*\*Overlap:\*\*/);
  assert.match(research, /gh pr diff <pr> --repo "\$REPO" > "\$RUN_DIR\/inflight\/<key>\/pr\.diff"/);
  assert.match(research, /git rev-parse --verify --quiet "origin\/<branch>"/);
  assert.match(research, /git rev-parse --is-shallow-repository/);
  assert.match(research, /git cat-file -e/);
  assert.match(research, /untrusted/);
  assert.match(section(research, 'Outputs'), /\$RUN_DIR\/inflight\//);
  assert.match(step(section(research, 'Steps'), 3), /In-flight overlap/);
});

test('stage 3 refreshes the count, passes it to grade, and waits through a verified deferred comment (16c)', () => {
  const grade = read('stages/03-grade.md');
  for (const needle of ['`waitFor`', '`waitOverride`', '--active-runs-file "$RUN_DIR/active-runs.json"', '`waitLine`', 'node "$PIPELINE" waiting-for --repo "$REPO" --issue "$NUMBER" --expect', '--expect-locked']) {
    assert.ok(grade.includes(needle), `03-grade.md lacks ${needle}`);
  }
  assert.match(grade, /Reply to resume, or add `pipeline-go` to accept the recommendations; it also lets this issue run alongside runs in progress\./);
  const wait = section(grade, 'Automatic mode').split('- **wait:**')[1] ?? '';
  assert.ok(wait, '03-grade.md Automatic mode needs a **wait:** case');
  assert.doesNotMatch(wait, /add-blocked-by/);
  assert.doesNotMatch(wait, /tracker:add-labels/);
  assert.match(wait, /no `needs-decision`/);
  assert.match(wait, /kind `deferred`/);
  assert.ok(wait.indexOf('tracker:remove-labels` `pipeline-working`') < wait.indexOf('rm -rf "$RUN_DIR"'), 'the wait removes RUN_DIR last, as stage 10 does');
  assert.match(grade, /as research\.md names it, which is the key `active-runs\.json` used at stage 0/);
  assert.match(wait, /This issue becomes eligible again once none of these runs is in progress: the sweep or the next poll picks it up, or run `\/ship #<NUMBER>` again\. To run it alongside them anyway, add `pipeline-go`\./);
  assert.ok(wait.indexOf('kind `deferred`') < wait.indexOf('waiting-for') && wait.indexOf('waiting-for') < wait.indexOf('tracker:remove-labels` `pipeline-working`'),
    'post deferred, read it back, then release the lock');
  const interactive = section(grade, 'Interactive mode');
  assert.match(interactive, /Wait for <labels> \(posts `deferred` and stops\), or go ahead alongside\?/);
  assert.match(interactive, /`waitOverride`/);
});

test('interactive fork and too-big ask the wait question first, before the fork questions or the split choice (16c round 2)', () => {
  const interactive = section(read('stages/03-grade.md'), 'Interactive mode');
  const line = (verdict) => interactive.split('\n').find((l) => l.startsWith(`- **${verdict}:**`)) ?? '';
  const fork = line('fork');
  assert.match(fork, /`waitFor`/, fork);
  assert.ok(fork.indexOf('wait question') >= 0 && fork.indexOf('wait question') < fork.indexOf('ask the questions one at a time'), fork);
  const big = line('too-big');
  assert.match(big, /`waitFor`/, big);
  assert.ok(big.indexOf('wait question') >= 0 && big.indexOf('wait question') < big.indexOf('show the proposed split'), big);
  for (const l of [fork, big]) assert.doesNotMatch(l, /Went ahead alongside/, 'the go-ahead is recorded once, in the wait question');

  const question = interactive.split('**The wait question.**')[1] ?? '';
  assert.match(question, /Wait for <labels> \(posts `deferred` and stops\), or go ahead alongside\?/);
  const onWait = question.split('\n').find((l) => l.startsWith('- **On wait:**')) ?? '';
  assert.match(onWait, /\*\*Verdict:\*\* \\`wait\\`|\*\*Verdict:\*\* `wait`/, onWait);
  assert.match(onWait, /Also found: <the fork or too-big reasons>\. They are graded again when the issue can start\./);
  assert.doesNotMatch(onWait, /are asked when/);
  assert.match(onWait, /automatic \*\*wait\*\* steps with grade\.json's `waitFor` and `waitLine`/);
  assert.match(onWait, /no fork question/i);
  assert.ok(onWait.indexOf('Verdict') < onWait.indexOf('automatic **wait** steps'), 'grade.md is rewritten before the wait steps post it');
  const onGo = question.split('\n').find((l) => l.startsWith('- **On go ahead:**')) ?? '';
  assert.match(onGo, /`waitOverride`/);
  assert.match(onGo, /Went ahead alongside <labels>: you/);
  assert.match(onGo, /fork questions or the split choice/);
});

test('"## Waiting for" is appended once, by the automatic wait steps; the interactive paths only refer to them (16c round 2)', () => {
  const grade = read('stages/03-grade.md');
  assert.equal(grade.match(/[Aa]ppend[^\n]*"## Waiting for"/g)?.length, 1);
  assert.match(section(grade, 'Automatic mode').split('- **wait:**')[1] ?? '', /^\s*1\. Append a "## Waiting for" section/);
  assert.doesNotMatch(section(grade, 'Interactive mode'), /[Aa]ppend[^\n]*"## Waiting for"/);
});

test('research skips runs that can never be waited on and survives a failed fetch (16c round 1)', () => {
  const research = read('stages/02-research.md');
  const step1 = step(section(research, 'Steps'), 1);
  assert.match(step1, /`issue` is `null`/);
  assert.match(step1, /\$RUN_DIR\/inflight\/<key>\/error\.txt/);
  assert.match(research, /for a PR run, its title; the diff is its evidence/);
  const overlap = research.split('**In-flight overlap:**')[1]?.split('\n   - ')[0] ?? '';
  assert.match(overlap, /for each run in `ahead` whose `issue` isn't `null`/);
});

test("SKILL.md rebuilds active-runs.json without --expect-locked, and warns before a user-ended report ends a wait (16c round 1)", () => {
  const skill = read('SKILL.md');
  const rebuild = skill.match(/rebuild RUN_DIR's inputs[^\n]*/)?.[0] ?? '';
  assert.match(rebuild, /`tracker:active-runs` \(without `--expect-locked`/);
  assert.doesNotMatch(rebuild.replace('without `--expect-locked`', ''), /--expect-locked/);
  const stop = section(skill, 'Stop procedure');
  const interactive = stop.match(/^2\. \*\*Interactive mode:\*\*.*$/m)?.[0] ?? '';
  const warnAt = interactive.indexOf('waiting-for');
  assert.ok(warnAt >= 0 && warnAt < interactive.indexOf('kind `report`'), interactive);
  assert.match(interactive, /ends that wait/);
});

test('the grade template has the Waits for row (16c)', () => {
  const template = read('templates/grade.md');
  assert.match(template, /\| Waits for \(runs ahead\) \| <none, or #n \(relation\), …; or "went ahead alongside …"> \|/);
  assert.doesNotMatch(template, /Conflicts with an open/);
});

test('the active-runs tracker operation runs the CLI and says the text is untrusted data (16c)', () => {
  const ops = read('trackers/github.md').split('\n## ').find((s) => s.startsWith('active-runs')) ?? '';
  assert.match(ops, /node "\$PIPELINE" active-runs --repo "\$REPO" --issue "\$NUMBER" --config-file "\$RUN_DIR\/config\.json" > "\$RUN_DIR\/active-runs\.json"/);
  for (const field of ['self', 'runs', 'ahead', 'maxParallel', 'admitted', 'related', 'textWithheld']) assert.match(ops, new RegExp(`\`${field}`));
  assert.match(ops, /untrusted/);
});

test('stage 0 and stage 3 pass --expect-locked (16c)', () => {
  assert.match(read('stages/00-resolve.md'), /--expect-locked/);
  assert.match(read('stages/03-grade.md'), /--expect-locked/);
});

test('README says the interactive wait question comes before the fork questions and the split choice (16c round 3)', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const override = readme.split('\n').find((l) => l.startsWith('- **Overriding it.**')) ?? '';
  assert.match(override, /before/);
  assert.doesNotMatch(override, /after fork questions are answered|told to proceed/);
});

test('Phase 2a: stage 7 runs the revert check and records it', () => {
  const verify = read('stages/07-verify.md');
  assert.match(verify, /node "\$PIPELINE" revert-check --base "\$BASE_SHA" --command/);
  assert.match(verify, /Revert check/);
  assert.match(verify, /could not run/);
});

test('Phase 2a: stage 8 runs diff-risk and classifies skip markers as Critical confessions', () => {
  const review = read('stages/08-review.md');
  assert.match(review, /node "\$PIPELINE" diff-risk --base "\$BASE_SHA"/);
  assert.match(review, /Diff risk/);
  assert.match(review, /skip-marker/);
});

test('Phase 2a: stage 9 writes intent and diff risk into the PR body', () => {
  const finish = read('stages/09-finish.md');
  for (const s of ['How it works', 'Alternatives rejected', 'Diff risk']) assert.match(finish, new RegExp(s), s);
});

test('Phase 2a: stage 10 tells the owner about pipeline-ready, not a Phase 2 merge gate', () => {
  const report = read('stages/10-report.md');
  assert.match(report, /pipeline-ready/);
  assert.doesNotMatch(report, /merge gate arrives in Phase 2/);
});

test('Phase 2a: fix mode removes pipeline-fix first, reads the verdict, then the owner reply, then review comments', () => {
  const fix = read('stages/fix.md');
  const steps = fix.split('## Steps')[1].split('\n## ')[0];
  const removeAt = steps.indexOf('`tracker:remove-pr-labels` `pipeline-fix`');
  const verdictAt = steps.indexOf('node "$PIPELINE" verdict-latest');
  const replyAt = steps.indexOf("**The owner's reply.**");
  const commentsAt = steps.indexOf('Review comments');
  assert.ok(removeAt > 0 && verdictAt > removeAt && replyAt > verdictAt && commentsAt > replyAt, 'order: remove label, verdict, reply, comments');
  assert.match(fix, /human-decision-needed/);
  assert.match(steps, /Work out what to fix[\s\S]*fix-plan\.md/);
});

test('token leaks: SKILL.md has the output rule, the effort column and the subagent rules', () => {
  const text = read('SKILL.md');
  const rules = text.split('## Hard rules')[1]?.split('\n## ')[0] ?? '';
  assert.match(rules, /^11\. \*\*Keep tool output short\.\*\*/m);
  assert.match(rules, /tail -n 40/);
  const policy = text.split('## Model policy')[1] ?? '';
  assert.match(policy, /\| Work \| Model \| Effort \|/);
  assert.match(policy, /`--effort` in `claude_args`/);
  assert.match(policy, /three steps or fewer/);
  assert.match(policy, /30-line return limit/);
});

test('token leaks: context-hygiene.md has its five rules and no inlined copy lives in SKILL.md', () => {
  const hygiene = read('context-hygiene.md');
  assert.match(hygiene, /^# Context hygiene$/m);
  assert.equal((hygiene.match(/^- /gm) ?? []).length, 5);
  assert.doesNotMatch(read('SKILL.md'), /\/issue-pipeline:ship <KEY>/);
});

test('the score skill reads trusted issue text, judges the diff and the verdict, posts one score comment, and edits nothing', () => {
  const s = readFileSync(new URL('../skills/score/SKILL.md', import.meta.url), 'utf8');
  assert.match(s, /^name: score$/m);
  assert.match(s, /Adapted from warpdotdev\/warp-factory-examples \(MIT License, Copyright \(c\) 2026 Warp\)/);
  assert.match(s, /never from the PR's description of itself/);
  for (const v of ['compliant', 'partial', 'non_compliant', 'actionable', 'vague', 'empty_or_noise']) assert.match(s, new RegExp(`\`${v}\``));
  assert.match(s, /node "\$PIPELINE" score --head/);
  assert.match(s, /gh pr comment <PR> --repo "\$REPO" --body-file/);
});

test('hydrate: stage 0 fetches after the lock; stage 2 reads the index first, by line range, and records a Context section', () => {
  const s0 = read('stages/00-resolve.md');
  assert.match(s0, /node "\$PIPELINE" hydrate --issue-file "\$RUN_DIR\/issue\.json" --config-file "\$RUN_DIR\/config\.json" --out "\$RUN_DIR\/context\/"/);
  assert.ok(s0.indexOf('" hydrate') > s0.indexOf('kind `lock`'), 'hydrate runs after the lock');
  const s2 = read('stages/02-research.md');
  assert.match(s2, /`\$RUN_DIR\/context\/index\.md` first, before any search/);
  assert.match(s2, /by line range/);
  assert.match(s2, /never read `context\/` wholesale/);
  assert.match(s2, /`## Context`/);
  assert.match(s2, /all six sections/);
});

test('measurement: stages are marked, run.json goes in the commit before each push, the report quotes the summary', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /node "\$PIPELINE" stage-mark --run-dir "\$RUN_DIR" --stage <n>/);
  assert.match(skill, /run-record [^\n]*--stopped-at <N>/);
  assert.ok(skill.trimEnd().split('\n').length < 100, 'SKILL.md must stay under 100 lines');
  const finish = read('stages/09-finish.md');
  assert.ok(finish.includes('run-record') && finish.indexOf('run-record') < finish.indexOf('git push -u origin "$BRANCH"'), 'stage 9 records before it pushes');
  assert.match(finish, /--kind ship [^\n]*--grade-file "\$RUN_DIR\/grade\.json"/);
  const fix = read('stages/fix.md');
  assert.ok(fix.includes('run-record') && fix.indexOf('run-record') < fix.indexOf('git push origin "$BRANCH"'), 'fix mode records before it pushes');
  assert.match(fix, /--kind fix [^\n]*--verdict-file "\$RUN_DIR\/verdict\.json"/);
  assert.match(skill, /--grade-file "\$RUN_DIR\/grade\.json"[^\n]*--verdict-file "\$RUN_DIR\/verdict\.json"[^\n]*`<N>` is the stage number, or `fix` in fix mode/);
  assert.match(skill, /stage 0 step 13 \(hydrate\), so `context\/` is regenerated/);
  assert.match(fix, /Then run `node "\$PIPELINE" stage-mark --run-dir "\$RUN_DIR" --stage fix` again, so step 11's time is not charged to stage 8/);
  assert.ok(fix.indexOf('--stage fix` again') > fix.indexOf('Run stage 7 and stage 8') && fix.indexOf('--stage fix` again') < fix.indexOf('--kind fix'), 'fix mode re-marks between stage 8 and its run-record');
  for (const f of ['stages/09-finish.md', 'stages/fix.md']) {
    assert.match(read(f), /A `\{"warning":…\}` line on stderr means a field was recorded as null; mention it in the final summary\./, `${f} tells the agent what a warning line means`);
  }
  assert.match(read('stages/02-research.md'), /If index\.md is missing or lists nothing, go straight to the search\./);
  assert.match(read('stages/10-report.md'), /node "\$PIPELINE" run-summary --file "docs\/pipeline\/\$KEY\/run\.json"/);
  for (const f of ['SKILL.md', 'stages/09-finish.md', 'stages/10-report.md', 'stages/fix.md']) {
    assert.match(read(f), /`run-(record|summary)` exits non-zero/, `${f} says what to do when run-record or run-summary fails`);
  }
});

// --- the review skill ---

const readReview = (rel) => readFileSync(new URL(`../skills/review/${rel}`, import.meta.url), 'utf8');

test('review SKILL.md names the five trust-nothing steps', () => {
  const text = readReview('SKILL.md').toLowerCase();
  for (const step of ['re-run', 'revert check', 'screenshot', 'flaky', 'not instructions']) assert.match(text, new RegExp(step));
});

test('review SKILL.md forbids approving, requesting changes, merging, pushing and posting anything but the verdict', () => {
  const rules = readReview('SKILL.md').split('## Hard rules')[1].split('\n## ')[0];
  for (const s of ['gh pr review', 'merge', 'push', 'only comment']) assert.match(rules.toLowerCase(), new RegExp(s));
});

test('review SKILL.md fallback writes verdict.json, uses a detached worktree and passes the test command through a file', () => {
  const text = readReview('SKILL.md');
  const fallback = text.split('## If you cannot finish')[1];
  assert.ok(fallback.includes('> "$RUN_DIR/verdict.json"'));
  assert.ok(text.includes('git worktree add --detach'));
  const procedure = text.split('## Procedure')[1].split('\n## ')[0];
  assert.ok(procedure.includes('test-cmd.txt'));
});

test('review SKILL.md installs dependencies in the worktree during Setup', () => {
  const setup = readReview('SKILL.md').split('## Setup')[1].split('\n## ')[0];
  assert.match(setup, /npm ci/);
});

test('review SKILL.md allows bare npx rows only for installed local bins, run as `npx --no` (final review I11)', () => {
  const step = readReview('SKILL.md').match(/^2\. \*\*Re-run the evidence\.\*\*.*$/m)?.[0] ?? '';
  assert.match(step, /`npx <tool> …` or `npx --no <tool> …` only when `<tool>` is a bare name .* and `\$WT\/node_modules\/\.bin\/<tool>` exists/);
  assert.match(step, /always run as `npx --no <tool> …`/);
});
