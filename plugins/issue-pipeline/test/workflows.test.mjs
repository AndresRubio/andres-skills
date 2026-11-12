import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderWorkflow, defaultVars } from '../skills/ship/scripts/lib/setup.mjs';

const tpl = (name) => readFileSync(new URL(`../templates/github/${name}`, import.meta.url), 'utf8');
const rendered = (name) => renderWorkflow(tpl(name), defaultVars());

test('pipeline-review: job and check are both named pipeline-review; it never approves; the status step runs unless cancelled', () => {
  const t = rendered('pipeline-review.yml');
  assert.match(t, /^name: pipeline-review$/m);
  assert.match(t, /^  pipeline-review:\n    name: pipeline-review$/m);
  assert.match(t, /allowed_bots: "claude\[bot\]"/);
  assert.match(t, /prompt: "\/issue-pipeline:review \$\{\{ github\.event\.pull_request\.number \}\} --head \$\{\{ github\.event\.pull_request\.head\.sha \}\}"/);
  assert.match(t, /--model claude-fable-5-1/);
  assert.match(t, /--disallowedTools .*Bash\(gh pr review:\*\)/);
  assert.match(t, /if: \$\{\{ !cancelled\(\) \}\}\n[\s\S]*?run: node .*pipeline\.mjs" verdict-status .* --post-missing/);
  assert.doesNotMatch(t, /always\(\)/);
  assert.match(t, /head\.repo\.full_name == github\.repository/);
  assert.match(t, /ISSUE_PIPELINE_GUARD: '1'/);
  assert.doesNotMatch(t, /gh pr review --approve/);
});

test('pipeline-ready: deterministic, no AI, right triggers and permissions, concurrency not cancelled', () => {
  const t = rendered('pipeline-ready.yml');
  assert.match(t, /workflow_run:\n\s+workflows: \[CI, pipeline-review\]\n\s+types: \[completed\]/);
  assert.match(t, /pull_request:\n\s+types: \[labeled, unlabeled, synchronize, reopened, closed\]/);
  assert.match(t, /schedule:\n\s+- cron: '\*\/30 \* \* \* \*'/);
  assert.match(t, /cancel-in-progress: false/);
  assert.match(t, /contents: write\n\s+pull-requests: write\n\s+issues: write/);
  assert.doesNotMatch(t, /claude-code-action/);
  assert.doesNotMatch(t, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(t, /pipeline\.mjs" ready --repo-root \. --repo \$\{\{ github\.repository \}\}$/m);
  assert.doesNotMatch(t, /--config-file|pipeline\.mjs config/);
  assert.match(t, /git remote set-head origin --auto/);
  assert.match(t, /GH_TOKEN: \$\{\{ secrets\.PIPELINE_TOKEN \|\| github\.token \}\}/);
});

test('pipeline-ship: routes with lane-target, runs the action only when run is true, sets lane, guard and CI', () => {
  const t = rendered('pipeline-ship.yml');
  assert.match(t, /issues:\n\s+types: \[labeled\]/);
  assert.match(t, /issue_comment:\n\s+types: \[created\]/);
  assert.match(t, /pull_request:\n\s+types: \[labeled\]/);
  assert.match(t, /pipeline\.mjs" lane-target --event-file "\$GITHUB_EVENT_PATH" --event-name "\$\{\{ github\.event_name \}\}" --repo/);
  assert.match(t, /if: needs\.route\.outputs\.run == 'true'/);
  assert.match(t, /prompt: \$\{\{ needs\.route\.outputs\.prompt \}\}/);
  assert.match(t, /ISSUE_PIPELINE_LANE: github/);
  assert.match(t, /ISSUE_PIPELINE_GUARD: '1'/);
  assert.match(t, /CI: 'true'/);
  assert.match(t, /concurrency:\n\s+group: \$\{\{ needs\.route\.outputs\.concurrency \}\}/);
  assert.doesNotMatch(t, /^concurrency:/m);
  assert.equal((t.match(/actions\/setup-node@v4/g) || []).length, 2);
  assert.match(t, /--disallowedTools .*Bash\(gh pr merge:\*\)/);
});

test('no workflow edits .github/workflows or merges', () => {
  for (const name of ['pipeline-ship.yml', 'pipeline-review.yml', 'pipeline-ready.yml']) {
    // The --disallowedTools lists name `gh pr merge` in order to forbid it; only invocations count.
    const t = rendered(name).split('\n').filter((line) => !/--disallowedTools/.test(line)).join('\n');
    assert.doesNotMatch(t, /gh pr merge/, name);
    assert.doesNotMatch(t, /update-branch.*--force/, name);
  }
});

test('ship and review jobs set origin/HEAD right after the target-repo checkout (config reads the default branch)', () => {
  const ship = rendered('pipeline-ship.yml');
  const shipJob = ship.slice(ship.indexOf('\n  ship:\n'));
  // The ship job notes its start time first; the checkout is still followed at once by set-head.
  assert.match(shipJob, /\n      - uses: actions\/checkout@v4\n        with:\n          fetch-depth: 0\n      - run: git remote set-head origin --auto\n/);
  const review = rendered('pipeline-review.yml');
  assert.match(review, /steps:\n      - uses: actions\/checkout@v4\n        with:\n          fetch-depth: 0\n          ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n      - run: git remote set-head origin --auto\n/);
});

test('pipeline-ready warns when PIPELINE_TOKEN is missing, before deciding, and still falls back to the default token', () => {
  const t = rendered('pipeline-ready.yml');
  const warn = t.indexOf('PIPELINE_TOKEN is not set; fix requests and branch updates will not trigger workflows');
  assert.ok(warn > 0, 'missing warning');
  assert.ok(warn < t.indexOf('name: Decide and act'), 'the warning must come before Decide and act');
  // The secrets context is not available in a step-level if:, so the check runs in the shell.
  assert.match(t, /PIPELINE_TOKEN_SET: \$\{\{ secrets\.PIPELINE_TOKEN != '' \}\}/);
  assert.match(t, /if \[ "\$PIPELINE_TOKEN_SET" != "true" \]; then echo "::warning::PIPELINE_TOKEN is not set/);
  assert.doesNotMatch(t, /^\s+if: .*secrets\./m);
  assert.doesNotMatch(t, /GitHub App token/);
  assert.match(t, /GH_TOKEN: \$\{\{ secrets\.PIPELINE_TOKEN \|\| github\.token \}\}/);
});

// Checked out inside the workspace, the plugin's own tests are collected by the repo's test runner:
// on the first sandbox run a plain `npm test` failed with 59 files that were not the repo's.
test('every workflow clones the pinned plugin outside the workspace and calls its CLI from there', () => {
  const home = '$RUNNER_TEMP/issue-pipeline-plugin';
  for (const name of ['pipeline-ship.yml', 'pipeline-review.yml', 'pipeline-ready.yml', 'pipeline-score.yml']) {
    const t = rendered(name);
    assert.doesNotMatch(t, /\.issue-pipeline-plugin/, name);
    assert.doesNotMatch(t, /repository: AndresRubio\/andres-skills/, name);
    assert.ok(t.includes(`run: git -c advice.detachedHead=false clone --quiet --depth 1 --branch ${defaultVars().PLUGIN_REF} https://github.com/AndresRubio/andres-skills.git "${home}"`), name);
    for (const line of t.split('\n').filter((l) => /pipeline\.mjs/.test(l))) {
      assert.ok(line.includes(`node "${home}/plugins/issue-pipeline/skills/ship/scripts/pipeline.mjs" `), `${name}: ${line.trim()}`);
    }
  }
});

test('the agent loads the pinned plugin clone with --plugin-dir, never the marketplace HEAD', () => {
  for (const name of ['pipeline-ship.yml', 'pipeline-review.yml', 'pipeline-score.yml']) {
    const t = rendered(name);
    assert.doesNotMatch(t, /plugin_marketplaces:|^\s+plugins:/m, name);
    assert.match(t, /claude_args: \|\n\s+--plugin-dir \$\{\{ runner\.temp \}\}\/issue-pipeline-plugin\/plugins\/issue-pipeline\/\n/, name);
  }
});

test('both agent lanes run at --effort high, never max (token-leaks amendment D)', () => {
  for (const name of ['pipeline-ship.yml', 'pipeline-review.yml']) {
    const t = rendered(name);
    assert.match(t, /claude_args: \|\n(?:\s+--[^\n]+\n)*\s+--effort high\n/, name);
    assert.doesNotMatch(t, /--effort max/, name);
  }
});

test('pipeline-ship: a workflow_dispatch with an issue input is routed like the other events', () => {
  const t = rendered('pipeline-ship.yml');
  assert.match(t, /^  workflow_dispatch:\n    inputs:\n      issue:\n[\s\S]*?required: true\n\s+type: string/m);
});

test('pipeline-ready: the sweep runs on schedule, by hand and on a merged pipeline/* PR, and may dispatch workflows', () => {
  const t = rendered('pipeline-ready.yml');
  assert.match(t, /^  actions: write$/m);
  assert.match(t, /- name: Sweep deferred and waiting issues\n\s+if: \$\{\{ !cancelled\(\) && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'pull_request' && github\.event\.action == 'closed' && github\.event\.pull_request\.merged && startsWith\(github\.event\.pull_request\.head\.ref, 'pipeline\/'\)\)\) \}\}/);
  assert.match(t, /pipeline\.mjs" sweep --repo-root \. --repo \$\{\{ github\.repository \}\}/);
  const [readyAt, sweepAt] = [t.indexOf('pipeline.mjs" ready'), t.indexOf('pipeline.mjs" sweep')];
  assert.ok(readyAt !== -1 && readyAt < sweepAt, 'the sweep runs after the readiness pass');
});

test('pipeline-score: dispatched only, validates its input, haiku at low effort, never merges or pushes', () => {
  const t = rendered('pipeline-score.yml');
  assert.match(t, /^on:\n  workflow_dispatch:\n    inputs:\n      pr:/m);
  assert.doesNotMatch(t.slice(t.indexOf('\non:'), t.indexOf('\npermissions:')), /pull_request|issues|schedule/);
  assert.match(t, /case "\$PR" in ''\|\*\[!0-9\]\*\) exit 1;; esac/);
  assert.match(t, /prompt: "\/issue-pipeline:score \$\{\{ inputs\.pr \}\}"/);
  assert.match(t, /--model haiku/);
  assert.match(t, /--effort low/);
  assert.match(t, /--disallowedTools .*Bash\(gh pr merge:\*\).*Bash\(git push:\*\)/);
  assert.match(t, /contents: read\n\s+pull-requests: write/);
});

test('pipeline-ship: the effort recorded in run.json matches the --effort it runs with', () => {
  const t = rendered('pipeline-ship.yml');
  const flag = t.match(/claude_args: \|[\s\S]*?--effort (\w+)/)[1];
  const step = t.match(/- name: Run the pipeline\n[\s\S]*?\n {8}env:\n((?: {10}.*\n|\s*\n)+)/)[1];
  assert.match(step, new RegExp(`^ {10}ISSUE_PIPELINE_EFFORT: '?${flag}'?$`, 'm'));
});

test('pipeline-ship allows both claude[bot] and github-actions[bot], which a sweep dispatch with the default token runs as', () => {
  const t = rendered('pipeline-ship.yml');
  const bots = t.match(/^\s+allowed_bots: "([^"]*)"$/m)[1].split(',');
  assert.deepEqual(bots, ['claude[bot]', 'github-actions[bot]']);
});

test('pipeline-score allows github-actions[bot], which a pipeline-ready dispatch without PIPELINE_TOKEN runs as', () => {
  const t = rendered('pipeline-score.yml');
  const bots = t.match(/^\s+allowed_bots: "([^"]*)"$/m)[1].split(',');
  assert.ok(bots.includes('github-actions[bot]'), bots.join(','));
});

test('pipeline-score blocks gh pr edit like pipeline-review does', () => {
  for (const name of ['pipeline-review.yml', 'pipeline-score.yml']) {
    assert.match(rendered(name), /--disallowedTools .*Bash\(gh pr edit:\*\)/, name);
  }
});

// claude-code-action splits claude_args like a shell: on whitespace, except inside quotes
// (base-action/src/parse-sdk-options.ts). A tool pattern with a space in it must be quoted to arrive whole.
const claudeArgs = (yaml) => {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => /^\s*claude_args: \|$/.test(l));
  const indent = lines[at].search(/\S/);
  const end = lines.findIndex((l, i) => i > at && l.trim() !== '' && l.search(/\S/) <= indent);
  return lines.slice(at + 1, end === -1 ? undefined : end).join('\n');
};
const shellWords = (text) => (text.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map((w) => w.replace(/["']/g, ''));

// Claude Code in a headless run denies Bash and file writes unless they are allowed, and then ends
// the session as a success with nothing done. The lists are what each skill needs (spec §6.2).
test('each workflow passes Claude whole flags, the tools its skill needs and the commands it must not run', () => {
  const FLAGS = ['--plugin-dir', '--model', '--effort', '--max-budget-usd', '--allowedTools', '--disallowedTools'];
  const readAndReport = ['Bash', 'Read', 'Write', 'Glob', 'Grep'];
  const noReview = ['Bash(gh pr merge:*)', 'Bash(gh pr review:*)', 'Bash(gh pr edit:*)', 'Bash(git push:*)'];
  const expected = {
    'pipeline-ship.yml': {
      allowed: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'Agent', 'Task', 'TodoWrite'],
      disallowed: ['Bash(gh pr merge:*)', 'Bash(gh pr review:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)'],
    },
    'pipeline-review.yml': { allowed: readAndReport, disallowed: noReview },
    'pipeline-score.yml': { allowed: readAndReport, disallowed: [...noReview, 'Edit'] },
  };
  for (const [name, { allowed, disallowed }] of Object.entries(expected)) {
    const words = shellWords(claudeArgs(rendered(name)));
    assert.deepEqual(words.filter((w) => w.startsWith('--') && !FLAGS.includes(w)), [], `${name}: unknown flags`);
    // The values of a flag are the words up to the next flag, each split on commas, as the action reads them.
    const valuesOf = (flag) => {
      const from = words.indexOf(flag) + 1;
      if (from === 0) return [];
      const next = words.findIndex((w, i) => i >= from && w.startsWith('--'));
      return words.slice(from, next === -1 ? undefined : next).flatMap((v) => v.split(','));
    };
    assert.deepEqual(valuesOf('--allowedTools'), allowed, `${name}: allowed tools`);
    assert.deepEqual(valuesOf('--disallowedTools'), disallowed, `${name}: disallowed tools`);
  }
});

test('pipeline-ship checks in code that the session started, against the pipeline home the Claude step used', () => {
  const t = rendered('pipeline-ship.yml');
  assert.match(t, /^      key: \$\{\{ steps\.target\.outputs\.key \}\}$/m);
  assert.match(t, /echo "key=\$\(echo "\$out" \| node -e .*\)\.key.*\)" >> "\$GITHUB_OUTPUT"/);
  const homes = [...t.matchAll(/^\s+ISSUE_PIPELINE_HOME: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(homes, [homes[0], homes[0]], 'the Claude step and the check name the same home');
  // The ship job notes when this attempt began before anything else: every attempt of an Actions run
  // shares one run link, so the check tells them apart by time.
  const ship = t.slice(t.indexOf('\n  ship:\n'));
  const noted = ship.indexOf('run: echo "ATTEMPT_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_ENV"');
  assert.ok(noted !== -1 && noted < ship.indexOf('uses: actions/checkout@v4'), 'the start time is the first step');
  const afterClaude = t.slice(t.indexOf('uses: anthropics/claude-code-action@v1'));
  // It runs when the Claude step failed, and when the job timed out or was cancelled: a run that
  // reaches the 150-minute limit is the one most likely to still hold the lock.
  assert.match(afterClaude, /if: \$\{\{ always\(\) \}\}\n\s+env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}\n[\s\S]*?KEY: \$\{\{ needs\.route\.outputs\.key \}\}\n\s+run: node "\S*pipeline\.mjs" ship-status --home "\$ISSUE_PIPELINE_HOME" --repo \$\{\{ github\.repository \}\} --key "\$KEY" --since "\$ATTEMPT_STARTED" --post-missing$/m);
});

