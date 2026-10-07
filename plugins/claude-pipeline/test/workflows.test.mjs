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
  assert.match(t, /pipeline\.mjs ready --repo \$\{\{ github\.repository \}\} --config-file/);
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
  assert.match(t, /plugin_marketplaces: https:\/\/github\.com\/AndresRubio\/andres-skills\.git/);
  assert.match(t, /plugins: claude-pipeline@andres-skills/);
});

test('no workflow edits .github/workflows or merges', () => {
  for (const name of ['claude-ship.yml', 'claude-review.yml', 'pipeline-ready.yml']) {
    // The --disallowedTools lists name `gh pr merge` in order to forbid it; only invocations count.
    const t = rendered(name).split('\n').filter((line) => !/--disallowedTools/.test(line)).join('\n');
    assert.doesNotMatch(t, /gh pr merge/, name);
    assert.doesNotMatch(t, /update-branch.*--force/, name);
  }
});
