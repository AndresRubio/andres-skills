import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { COMMANDS } from '../skills/ship/scripts/lib/commands.mjs';
import { MARKER_KINDS } from '../skills/ship/scripts/lib/marker.mjs';
import { SKILL_DIR, read, headings, markdownFiles, section, step } from './helpers/skill.mjs';

// The ship skill's text against the code and against itself: every CLI command it names exists,
// every tracker operation and marker kind it uses is defined, the stage table matches stages/ on
// disk, templates and stages have their sections, and the commands it tells the agent to run have
// the shapes the run guard accepts. Tests that pin a particular sentence of the skill text are in
// skill-wording.test.mjs.

const TRACKER_OPS = ['read-issue', 'post-comment', 'add-labels', 'remove-labels', 'set-in-progress', 'create-issue', 'create-sub-issue', 'add-blocked-by', 'active-runs', 'create-pr', 'remove-pr-labels'];

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

test('SKILL.md carries the eleven hard rules and the stop procedure', () => {
  const text = read('SKILL.md');
  const rules = text.split('## Hard rules')[1]?.split('\n## ')[0] ?? '';
  for (let n = 1; n <= 11; n += 1) assert.match(rules, new RegExp(`^${n}\\. \\*\\*`, 'm'), `hard rule ${n} missing`);
  assert.ok(headings(text).includes('Stop procedure'));
  assert.ok(headings(text).includes('Model policy'));
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

test('no bare `git push` remains under skills/ship (B4)', () => {
  for (const file of markdownFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      assert.doesNotMatch(line, /git push(`|$)/, `${path.relative(SKILL_DIR, file)} has a bare "git push": ${line}`);
    }
  }
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

test('no backticked span under skills/ship combines a git push with a command substitution (16a fix)', () => {
  for (const file of markdownFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(/`([^`\n]+)`/g)) {
      assert.ok(!(m[1].includes('git push') && m[1].includes('$(')), `${path.relative(SKILL_DIR, file)}: ${m[1]}`);
    }
  }
});

// --- Task 16c: runs in progress (D16) ---

function allFiles(dir = SKILL_DIR) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

test('no file under skills/ mentions the removed count, field or file (16c)', () => {
  for (const file of allFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const gone of ['open-pipeline-pr-count', 'pr-count', 'conflictsWithOpenPipelinePr', 'open-prs.json', 'countOpenPipelinePrs', 'open-pipeline-prs']) {
      assert.ok(!text.includes(gone), `${path.relative(SKILL_DIR, file)} still mentions ${gone}`);
    }
  }
});

import { checkCommand } from '../skills/ship/scripts/lib/guard.mjs';

test("research's evidence fetches are non-fatal and pass the run guard (16c round 2)", () => {
  const step1 = step(section(read('stages/02-research.md'), 'Steps'), 1);
  const spans = [...step1.matchAll(/`([^`\n]*(?:2>>|^find |find "\$RUN_DIR)[^`\n]*)`/g)].map((m) => m[1]);
  const fetches = spans.filter((c) => c.includes('2>>'));
  for (const tool of ['gh pr diff', 'git diff', 'gh api', 'git show']) {
    const c = fetches.find((f) => f.startsWith(tool));
    assert.ok(c, `02-research step 1 has no non-fatal ${tool}`);
    assert.match(c, / 2>> "\$RUN_DIR\/inflight\/<key>\/error\.txt" \|\| true$/, c);
  }
  assert.ok(spans.includes('find "$RUN_DIR/inflight/<key>" -type f -empty -delete'), spans.join('\n'));
  assert.doesNotMatch(step1, /\[ -s /);
  assert.match(step1, /an `error\.txt` means/i);
  assert.match(step1, /empty folder/);
  const fill = (c) => c.replace(/<pr>/g, '40').replace(/<key>/g, '8').replace(/<base branch>/g, 'main')
    .replace(/<branch>/g, 'pipeline/8-x').replace(/<file>/g, 'spec.md');
  for (const c of spans) {
    const command = `. '/tmp/run-x/vars.sh' && cd "$WT" && ${fill(c)}`;
    assert.deepEqual(checkCommand(command, { home: '/tmp/no-pipeline-home', readFile: () => '' }), { allow: true }, command);
  }
});

// --- Task 10: Phase 2a stage edits (D15, D18) ---

test('Phase 2a: evidence template has the revert-check and diff-risk sections', () => {
  const h = headings(read('templates/evidence.md'));
  for (const s of ['Revert check', 'Diff risk']) assert.ok(h.includes(s), `templates/evidence.md lacks ## ${s}`);
  assert.match(read('templates/evidence.md'), /could not run/);
});

test('token leaks: SKILL.md stays under 100 lines and loads its files lazily', () => {
  const text = read('SKILL.md');
  assert.ok(text.trimEnd().split('\n').length < 100, 'SKILL.md must stay under 100 lines');
  for (const f of readdirSync(path.join(SKILL_DIR, 'stages')).filter((n) => n.endsWith('.md'))) {
    assert.ok(text.includes(`stages/${f}`), `SKILL.md does not reference stages/${f}`);
  }
  for (const rel of ['context-hygiene.md', 'trackers/github.md']) {
    assert.ok(statSync(path.join(SKILL_DIR, rel)).isFile(), `${rel} is missing`);
    assert.ok(text.includes(rel), `SKILL.md does not reference ${rel}`);
  }
});
