import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderWorkflow, defaultVars } from '../skills/ship/scripts/lib/setup.mjs';

const tpl = (name) => readFileSync(new URL(`../templates/github/${name}`, import.meta.url), 'utf8');
const rendered = (name) => renderWorkflow(tpl(name), defaultVars());

test('claude-review: job and check are both named claude-review; it never approves; the status step always runs', () => {
  const t = rendered('claude-review.yml');
  assert.match(t, /^name: claude-review$/m);
  assert.match(t, /^  claude-review:\n    name: claude-review$/m);
  assert.match(t, /allowed_bots: "claude\[bot\]"/);
  assert.match(t, /prompt: "\/claude-pipeline:review \$\{\{ github\.event\.pull_request\.number \}\} --head \$\{\{ github\.event\.pull_request\.head\.sha \}\}"/);
  assert.match(t, /--model claude-fable-5-1/);
  assert.match(t, /--disallowedTools .*Bash\(gh pr review:\*\)/);
  assert.match(t, /if: always\(\)[\s\S]*?run: node .*pipeline\.mjs verdict-status .* --post-missing/);
  assert.match(t, /head\.repo\.full_name == github\.repository/);
  assert.match(t, /CLAUDE_PIPELINE_GUARD: '1'/);
  assert.doesNotMatch(t, /gh pr review --approve/);
});

test('pipeline-ready: deterministic, no AI, right triggers and permissions, concurrency not cancelled', () => {
  const t = rendered('pipeline-ready.yml');
  assert.match(t, /workflow_run:\n\s+workflows: \[CI, claude-review\]\n\s+types: \[completed\]/);
  assert.match(t, /pull_request:\n\s+types: \[labeled, unlabeled, synchronize, reopened, closed\]/);
  assert.match(t, /schedule:\n\s+- cron: '\*\/30 \* \* \* \*'/);
  assert.match(t, /cancel-in-progress: false/);
  assert.match(t, /contents: write\n\s+pull-requests: write\n\s+issues: write/);
  assert.doesNotMatch(t, /claude-code-action/);
  assert.doesNotMatch(t, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(t, /pipeline\.mjs ready --repo-root \. --repo \$\{\{ github\.repository \}\}$/m);
  assert.doesNotMatch(t, /--config-file|pipeline\.mjs config/);
  assert.match(t, /git remote set-head origin --auto/);
  assert.match(t, /GH_TOKEN: \$\{\{ secrets\.PIPELINE_TOKEN \|\| github\.token \}\}/);
});

test('claude-ship: routes with lane-target, runs the action only when run is true, sets lane, guard and CI', () => {
  const t = rendered('claude-ship.yml');
  assert.match(t, /issues:\n\s+types: \[labeled\]/);
  assert.match(t, /issue_comment:\n\s+types: \[created\]/);
  assert.match(t, /pull_request:\n\s+types: \[labeled\]/);
  assert.match(t, /pipeline\.mjs lane-target --event-file "\$GITHUB_EVENT_PATH" --event-name "\$\{\{ github\.event_name \}\}" --repo/);
  assert.match(t, /if: needs\.route\.outputs\.run == 'true'/);
  assert.match(t, /prompt: \$\{\{ needs\.route\.outputs\.prompt \}\}/);
  assert.match(t, /CLAUDE_PIPELINE_LANE: github/);
  assert.match(t, /CLAUDE_PIPELINE_GUARD: '1'/);
  assert.match(t, /CI: 'true'/);
  assert.match(t, /concurrency:\n\s+group: \$\{\{ needs\.route\.outputs\.concurrency \}\}/);
  assert.doesNotMatch(t, /^concurrency:/m);
  assert.equal((t.match(/actions\/setup-node@v4/g) || []).length, 2);
  assert.match(t, /--disallowedTools .*Bash\(gh pr merge:\*\)/);
});

test('no workflow edits .github/workflows or merges', () => {
  for (const name of ['claude-ship.yml', 'claude-review.yml', 'pipeline-ready.yml']) {
    // The --disallowedTools lists name `gh pr merge` in order to forbid it; only invocations count.
    const t = rendered(name).split('\n').filter((line) => !/--disallowedTools/.test(line)).join('\n');
    assert.doesNotMatch(t, /gh pr merge/, name);
    assert.doesNotMatch(t, /update-branch.*--force/, name);
  }
});

test('ship and review jobs set origin/HEAD right after the target-repo checkout (config reads the default branch)', () => {
  const ship = rendered('claude-ship.yml');
  const shipJob = ship.slice(ship.indexOf('\n  ship:\n'));
  assert.match(shipJob, /steps:\n      - uses: actions\/checkout@v4\n        with:\n          fetch-depth: 0\n      - run: git remote set-head origin --auto\n/);
  const review = rendered('claude-review.yml');
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

test('the agent loads the pinned plugin checkout with --plugin-dir, never the marketplace HEAD', () => {
  for (const name of ['claude-ship.yml', 'claude-review.yml']) {
    const t = rendered(name);
    assert.doesNotMatch(t, /plugin_marketplaces:|^\s+plugins:/m, name);
    assert.match(t, /claude_args: \|\n\s+--plugin-dir \.claude-pipeline-plugin\/plugins\/claude-pipeline\/\n/, name);
    assert.match(t, /repository: AndresRubio\/andres-skills\n\s+ref: claude-pipeline--v\d+\.\d+\.\d+\n\s+path: \.claude-pipeline-plugin/, name);
    assert.match(t, /# Verify on the first sandbox run that claude-code-action passes --plugin-dir through\./, name);
  }
});
