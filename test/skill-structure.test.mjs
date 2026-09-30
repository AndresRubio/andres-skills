import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../skills/ship/scripts/lib/commands.mjs';
import { MARKER_KINDS } from '../skills/ship/scripts/lib/marker.mjs';

export const SKILL_DIR = fileURLToPath(new URL('../skills/ship/', import.meta.url));
export const read = (rel) => readFileSync(path.join(SKILL_DIR, rel), 'utf8');
export const headings = (text) => [...text.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1].trim());

export function markdownFiles(dir = SKILL_DIR) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'scripts' ? [] : markdownFiles(full);
    return name.endsWith('.md') ? [full] : [];
  });
}

export const TRACKER_OPS = ['read-issue', 'post-comment', 'add-labels', 'remove-labels', 'set-in-progress', 'create-issue', 'create-sub-issue', 'add-blocked-by', 'open-claude-pr-count', 'create-pr'];

test('every node "$PIPELINE" <command> reference names a real command', () => {
  for (const file of markdownFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(/node "\$PIPELINE" ([a-z-]+)/g)) {
      assert.ok(m[1] in COMMANDS, `${path.relative(SKILL_DIR, file)} references unknown command "${m[1]}"`);
    }
  }
});

test('every tracker:<op> reference is defined by the GitHub adapter', () => {
  const defined = new Set(headings(read('trackers/github.md')));
  for (const file of markdownFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(/tracker:([a-z-]+)/g)) {
      assert.ok(defined.has(m[1]), `${path.relative(SKILL_DIR, file)} references undefined tracker:${m[1]}`);
    }
  }
});

test('the GitHub adapter defines every tracker operation', () => {
  const defined = headings(read('trackers/github.md'));
  for (const op of TRACKER_OPS) assert.ok(defined.includes(op), `trackers/github.md lacks ## ${op}`);
});

test('every marker kind named in the skill is a real kind', () => {
  for (const file of markdownFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(/kind `([a-z-]+)`/g)) {
      assert.ok(MARKER_KINDS.includes(m[1]), `${path.relative(SKILL_DIR, file)} uses unknown marker kind "${m[1]}"`);
    }
  }
});

test('templates have their required sections', () => {
  const need = {
    'templates/spec.md': ['Problem Statement', 'Solution', 'User Stories', 'Acceptance Criteria', 'Assumptions', 'Implementation Decisions', 'Testing Decisions', 'Out of Scope', 'Further Notes'],
    'templates/grade.md': ['Why', 'Checklist', 'Assumptions', 'Research summary'],
    'templates/evidence.md': ['Commands', 'Visible change', 'Screenshots', 'Departures from spec', 'Self-review', 'Known issues'],
    'templates/progress.md': ['Run', 'Stages', 'Tasks'],
  };
  for (const [file, sections] of Object.entries(need)) {
    const h = headings(read(file));
    for (const s of sections) assert.ok(h.includes(s), `${file} lacks ## ${s}`);
  }
  assert.match(read('templates/grade.md'), /\*\*Verdict:\*\* `<verdict>`/);
  assert.match(read('templates/spec.md'), /Adapted from mattpocock\/skills \(MIT License, Copyright \(c\) 2026 Matt Pocock\)/);
});

test('the adapter links sub-issues and blockers in single commands', () => {
  const text = read('trackers/github.md');
  assert.match(text, /-F sub_issue_id="\$\(gh api/);
  assert.match(text, /-F issue_id="\$\(gh api/);
  assert.doesNotMatch(text, /CHILD_ID=/);
  assert.doesNotMatch(text, /BLOCKER_ID=/);
});

test('SKILL.md is a model-invocable skill named ship', () => {
  const text = read('SKILL.md');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, 'SKILL.md needs YAML frontmatter');
  assert.match(front[1], /^name: ship$/m);
  assert.match(front[1], /^description: .{40,}$/m);
  assert.doesNotMatch(front[1], /disable-model-invocation/);
});

test('SKILL.md carries the ten hard rules and the stop procedure', () => {
  const text = read('SKILL.md');
  const rules = text.split('## Hard rules')[1]?.split('\n## ')[0] ?? '';
  for (let n = 1; n <= 10; n += 1) assert.match(rules, new RegExp(`^${n}\\. \\*\\*`, 'm'), `hard rule ${n} missing`);
  assert.ok(headings(text).includes('Stop procedure'));
  assert.ok(headings(text).includes('Model policy'));
});

test('SKILL.md keeps variables in vars.sh', () => {
  const text = read('SKILL.md');
  assert.match(text, /\. '<RUN_DIR>\/vars\.sh' &&/);
  assert.match(text, /printf "set -u\\n/);
  assert.match(text, /'\\''/);
  const wt = text.match(/`[^`]*worktree-remove-if-empty[^`]*`/);
  assert.ok(wt, 'worktree-remove-if-empty command not found');
  assert.match(wt[0], /^`\. '<RUN_DIR>\/vars\.sh' && node "\$PIPELINE" worktree-remove-if-empty/);
});

import { CHECKLIST_FIELDS } from '../skills/ship/scripts/lib/grade.mjs';

export const STAGE_SECTIONS = ['Inputs', 'Steps', 'Outputs', 'Automatic mode', 'Interactive mode'];
export function assertStage(file) {
  const h = headings(read(`stages/${file}`));
  for (const s of STAGE_SECTIONS) assert.ok(h.includes(s), `stages/${file} lacks ## ${s}`);
}

test('stages 0-3 have every required section', () => {
  for (const f of ['00-resolve.md', '01-isolate.md', '02-research.md', '03-grade.md']) assertStage(f);
});

test('the grade stage defines every checklist field', () => {
  const text = read('stages/03-grade.md');
  for (const field of Object.keys(CHECKLIST_FIELDS)) assert.match(text, new RegExp(`\`${field}\``), `03-grade.md does not define ${field}`);
});

test('stages 4-6 have every required section', () => {
  for (const f of ['04-spec.md', '05-plan.md', '06-build.md']) assertStage(f);
});

test('stages 7-10 and fix mode have every required section', () => {
  for (const f of ['07-verify.md', '08-review.md', '09-finish.md', '10-report.md', 'fix.md']) assertStage(f);
});

test("SKILL.md's stage table lists exactly the files in stages/", () => {
  const listed = [...new Set([...read('SKILL.md').matchAll(/`stages\/([a-z0-9-]+\.md)`/g)].map((m) => m[1]))].sort();
  const onDisk = readdirSync(path.join(SKILL_DIR, 'stages')).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(listed, onDisk);
});

test('no stage merges a PR', () => {
  for (const file of markdownFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/gh pr merge/g)) {
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
      assert.match(line, /forbidden|never|Never/i, `${path.relative(SKILL_DIR, file)} mentions gh pr merge outside a prohibition: ${line}`);
    }
  }
});

// --- final-review fix wave B ---

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

test('no bare `git push` remains under skills/ship (B4)', () => {
  for (const file of markdownFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      assert.doesNotMatch(line, /git push(`|$)/, `${path.relative(SKILL_DIR, file)} has a bare "git push": ${line}`);
    }
  }
});

test('a stopped run consumes claude-go instead of looping (B2)', () => {
  const skill = read('SKILL.md');
  const stop = skill.split('## Stop procedure')[1]?.split('\n## ')[0] ?? '';
  assert.match(stop, /remove-labels.*claude-go|claude-go.*remove-labels/s, 'stop procedure must remove claude-go');
  assert.match(stop, /accepts one set of recommendations/, 'stop procedure must explain that claude-go is single-use');

  const grade = read('stages/03-grade.md');
  assert.match(grade, /Reply with the values to resume/, '03-grade.md must offer a values-only reply when nothing but values is missing');
});

test('resolve and finish guard against a PR that already exists (B3)', () => {
  const resolve = read('stages/00-resolve.md');
  assert.match(resolve, /existing-prs\.json/);
  assert.match(resolve, /startswith\("claude\/<KEY>-"\)/);

  const finish = read('stages/09-finish.md');
  assert.match(finish, /gh pr list --repo "\$REPO" --head "\$BRANCH" --state open/);
  assert.match(finish, /reuse it as PR_URL|don't create another/);
});

test('set -u safe defaults for CI and CLAUDE_PIPELINE_LANE (B6)', () => {
  assert.match(read('stages/00-resolve.md'), /\$\{CLAUDE_PIPELINE_LANE:-github\}/);
  assert.match(read('stages/fix.md'), /\$\{CLAUDE_PIPELINE_LANE:-github\}/);
  assert.match(read('stages/01-isolate.md'), /\$\{CI:-\}/);
});

test('RUN_DIR is created under the pipeline home (B7)', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /CLAUDE_PIPELINE_HOME:-\$HOME\/\.claude-pipeline/);
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

// --- final-fix-R ---

// Groups a markdown file's lines into "instruction blocks": a top-level list item
// (or bare paragraph line) plus every indented continuation line that follows it,
// up to a blank line, a heading, or the next top-level item. A markdown table row
// is never part of a block (skipped entirely) — it's data (like the Stages table's
// "Produces" column), not an instruction.
function pushInstructionBlocks(text) {
  const blocks = [];
  let current = null;
  const closeCurrent = () => {
    if (current) blocks.push(current.join('\n'));
    current = null;
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith('|')) {
      closeCurrent();
      continue;
    }
    const isTopLevelItem = line === trimmed; // no leading whitespace: starts a new block
    if (isTopLevelItem) closeCurrent();
    if (current) current.push(line);
    else current = [line];
  }
  closeCurrent();
  return blocks;
}

// A line "instructs" a push when it contains the standalone word push outside any
// double-quoted text (a quoted string is someone else's literal wording — e.g. the
// "Push and create a Pull Request" menu option name from another skill — not our
// own prose) and isn't itself forbidding pushing (containing Never/never/forbidden)
// or talking about the push.default git setting.
function isPushInstructionLine(line) {
  const unquoted = line.replace(/"[^"]*"/g, '');
  if (!/\bpush\b/i.test(unquoted)) return false;
  if (/\b(never|forbidden)\b/i.test(line)) return false;
  if (/push\.default/i.test(line)) return false;
  return true;
}

test('every push instruction under skills/ship names the branch explicitly (R2)', () => {
  const EXPLICIT = /git push (-u )?origin "\$BRANCH"/;
  for (const file of markdownFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const block of pushInstructionBlocks(text)) {
      const blockLines = block.split('\n');
      if (!blockLines.some(isPushInstructionLine)) continue;
      assert.match(
        block,
        EXPLICIT,
        `${path.relative(SKILL_DIR, file)} has a push instruction without the explicit command:\n${block}`,
      );
    }
  }
});

test('hard rule 3 lists what may share a command with a push (16a fix)', () => {
  const rules = read('SKILL.md').split('## Hard rules')[1]?.split('\n## ')[0] ?? '';
  const rule3 = rules.match(/^3\. \*\*.*$/m)?.[0] ?? '';
  assert.match(rule3, /after sourcing vars\.sh, with only `cd`, `git add`, `git commit` and `git status` in the same command/);
  assert.doesNotMatch(rule3, /as its own command/);
});

test('no backticked span under skills/ship combines a git push with a command substitution (16a fix)', () => {
  for (const file of markdownFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(/`([^`\n]+)`/g)) {
      assert.ok(!(m[1].includes('git push') && m[1].includes('$(')), `${path.relative(SKILL_DIR, file)}: ${m[1]}`);
    }
  }
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
  assert.match(resolve, /headRefName == "claude\/<KEY>"/);
  assert.match(resolve, /startswith\("claude\/<KEY>-"\)/);
});

test('an existing PR is reused, not treated as a shortcut to stage 10 (R5)', () => {
  const finish = read('stages/09-finish.md');
  assert.doesNotMatch(finish, /go straight to stage 10/);
  assert.match(finish, /reuse it, skipping only the create step/);
  const automatic = finish.split('## Automatic mode')[1]?.split('\n## ')[0] ?? '';
  assert.match(automatic, /continue with the remaining steps/);
});

test('stage 10 clears claude-go and cleans up RUN_DIR (R6)', () => {
  const report = read('stages/10-report.md');
  assert.match(report, /remove-labels.*claude-working.*claude-go|claude-go.*if the issue has it/);
  assert.match(report, /rm -rf "\$RUN_DIR"/);
});

test('fix mode writes source.txt like stage 0, and inline comments use the REST field names (R7)', () => {
  const fix = read('stages/fix.md');
  assert.match(fix, /source\.txt/);
  assert.match(fix, /author_association/);
  assert.match(fix, /user\.login/);
});
