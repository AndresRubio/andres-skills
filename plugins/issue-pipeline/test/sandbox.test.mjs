import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../skills/ship/scripts/lib/config.mjs';
import { fillBody, bodyOf } from '../sandbox/fill-body.mjs';

const dir = (rel) => new URL(`../sandbox/${rel}`, import.meta.url);

test('the sandbox pipeline config is valid and uses small PR limits', () => {
  const c = validateConfig(JSON.parse(readFileSync(dir('app/.claude/pipeline.json'), 'utf8')));
  assert.equal(c.mergeDeploys, false);
  assert.deepEqual(c.maxPrSize, { files: 6, lines: 250 });
  assert.deepEqual(c.ciChecks, ['test']);
  assert.equal(c.maxParallel, 6);
});

test('the sandbox settings.json parses and denies destructive commands', () => {
  const settings = JSON.parse(readFileSync(dir('app/.claude/settings.json'), 'utf8'));
  const deny = settings.permissions.deny;
  assert.ok(Array.isArray(deny));
  assert.ok(deny.some((d) => d.includes('gh pr merge')), 'should deny gh pr merge');
  assert.ok(deny.some((d) => d.includes('git reset --hard')), 'should deny git reset --hard');
  assert.ok(deny.some((d) => d.includes('git push -u origin main')), 'should deny git push -u origin main (R11)');
  assert.ok(deny.some((d) => d.includes('git push origin +main')), 'should deny a force-push refspec to main (R11)');
  assert.ok(deny.includes('Bash(curl:*)'), 'should deny curl');
  assert.ok(deny.includes('Bash(wget:*)'), 'should deny wget');
});

test('every seeded issue has a title, labels and a body', () => {
  const files = readdirSync(dir('issues')).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files.sort(), ['01-wrong-month.md', '02-sort.md', '03-login.md', '04-bilingual.md', '05-empty-state.md', '06-protected-rename.md', '06b-ci-node.md', '07-title-typo.md', '09a-count.md', '09b-clear.md', '10-length-limit.md', '11a-author-italic.md', '11b-meta-description.md', '11c-count-by-author.md', '12-archive-toggle.md', '13-sort-stability.md', '15-hydrate.md']);
  for (const f of files) {
    const [title, labels, sep, ...body] = readFileSync(dir(`issues/${f}`), 'utf8').split('\n');
    assert.match(title, /^title: \S/, f);
    assert.match(labels, /^labels: [a-z,-]+$/, f);
    assert.equal(sep, '---', f);
    assert.ok(body.join('\n').trim().length > 10, f);
  }
});

test('the planted defects are present', () => {
  assert.match(readFileSync(dir('app/src/list.ts'), 'utf8'), /getUTCMonth\(\) \+ 1/);
  assert.match(readFileSync(dir('app/index.html'), 'utf8'), /<title>Readng List<\/title>/);
});

test('fixtures 01-07 (including 06b) and 10 carry the pipeline label; 09a, 09b and 11a-c do not', () => {
  const withLabel = ['01-wrong-month.md', '02-sort.md', '03-login.md', '04-bilingual.md', '05-empty-state.md', '06-protected-rename.md', '06b-ci-node.md', '07-title-typo.md', '10-length-limit.md', '12-archive-toggle.md', '13-sort-stability.md', '15-hydrate.md'];
  const withoutLabel = ['09a-count.md', '09b-clear.md', '11a-author-italic.md', '11b-meta-description.md', '11c-count-by-author.md'];
  const labelsOf = (f) => readFileSync(dir(`issues/${f}`), 'utf8').split('\n')[1].replace(/^labels: /, '').split(',');
  for (const f of withLabel) assert.ok(labelsOf(f).includes('pipeline'), f);
  for (const f of withoutLabel) assert.ok(!labelsOf(f).includes('pipeline'), f);
});

test('every label used on a seeded issue is a known sandbox label', () => {
  const known = new Set(['pipeline', 'pipeline-go', 'needs-local', 'needs-decision', 'pipeline-working', 'ready', 'pipeline-fix', 'bug', 'enhancement']);
  const files = readdirSync(dir('issues')).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const labelsLine = readFileSync(dir(`issues/${f}`), 'utf8').split('\n')[1];
    const labels = labelsLine.replace(/^labels: /, '').split(',');
    for (const label of labels) assert.ok(known.has(label), `${f}: unknown label "${label}"`);
  }
});

test('setup-sandbox.sh creates the ready label', () => {
  const src = readFileSync(dir('setup-sandbox.sh'), 'utf8');
  assert.match(src, /^label ready\s+\w{6} /m);
});

test('both sandbox scripts are syntactically valid bash', () => {
  for (const script of ['setup-sandbox.sh', 'recreate-issue.sh']) {
    assert.doesNotThrow(() => execFileSync('bash', ['-n', fileURLToPath(dir(script))]), script);
  }
});

test('issue 10 asks the automation to paste a private file and names the private repo placeholder', () => {
  const text = readFileSync(dir('issues/10-length-limit.md'), 'utf8');
  assert.ok(text.includes('{{PRIVATE_REPO}}'));
  assert.ok(text.includes('CANARY.md'));
});

test('setup-sandbox.sh can push through an ssh alias while the remote stays a github.com URL, and its first commit has no trailer', () => {
  const src = readFileSync(dir('setup-sandbox.sh'), 'utf8');
  const rewrite = src.indexOf('git config url."git@$SANDBOX_SSH_HOST:".insteadOf "git@github.com:"');
  assert.ok(rewrite > 0, 'the rewrite rule is set in the new clone');
  assert.match(src, /if \[ -n "\$\{SANDBOX_SSH_HOST:-\}" \]; then git config url\./, 'only when SANDBOX_SSH_HOST is set');
  assert.ok(rewrite > src.indexOf('git init -q -b main') && rewrite < src.indexOf('gh repo create'), 'after git init and before the push');
  assert.match(src, /^git commit -q -m "Initial sandbox app"$/m);
  assert.doesNotMatch(src, /Co-Authored-By/);
});

test('setup-sandbox.sh writes CANARY.md only for a private sandbox, before git add -A', () => {
  const src = readFileSync(dir('setup-sandbox.sh'), 'utf8');
  const block = src.match(/if \[ "\$visibility" = private \]; then\n([\s\S]*?)\nfi\n/);
  assert.ok(block, 'there is an `if [ "$visibility" = private ]` block');
  assert.match(block[1], /> CANARY\.md/);
  assert.match(block[1], /canary: \$dest\/CANARY\.md/);
  assert.ok(block.index < src.indexOf('git add -A'), 'the canary is written before git add -A');
  assert.equal(src.split('> CANARY.md').length - 1, 1, 'CANARY.md is written in exactly one place');
  assert.equal(readdirSync(dir('app')).includes('CANARY.md'), false, 'the app template has no CANARY.md');
});

test('seeded PR fixtures carry the files a fix run needs and the planted defects', () => {
  for (const name of ['12-archive-toggle', '13-sort-stability']) {
    const base = `prs/${name}/`;
    for (const f of ['docs/pipeline/KEY/spec.md', 'docs/pipeline/KEY/plan.md', 'docs/pipeline/KEY/progress.md', 'docs/pipeline/KEY/evidence.md', 'pr-body.md']) {
      assert.ok(existsSync(dir(base + f)), `${base}${f}`);
    }
  }
  const thirteen = readFileSync(dir('prs/13-sort-stability/src/list.test.ts'), 'utf8');
  assert.match(thirteen, /it\.only\(/);
  assert.match(readFileSync(dir('prs/12-archive-toggle/pr-body.md'), 'utf8'), /Decision needed/);
  assert.doesNotThrow(() => execFileSync('bash', ['-n', fileURLToPath(dir('seed-pr.sh'))]));
});

test('fill-body fills every placeholder and refuses a missing value', () => {
  const values = { PRIVATE_REPO: 'me/p', 'ISSUE:01-wrong-month.md': 12, 'PERMALINK:src/list.ts:21-24': 'https://github.com/me/s/blob/abc/src/list.ts#L21-L24', CI_RUN: 'https://github.com/me/s/actions/runs/9' };
  const resolve = (name, arg) => values[arg ? `${name}:${arg}` : name];
  assert.equal(
    fillBody('#{{ISSUE:01-wrong-month.md}} at {{PERMALINK:src/list.ts:21-24}}, run {{CI_RUN}}, repo {{PRIVATE_REPO}}', resolve),
    '#12 at https://github.com/me/s/blob/abc/src/list.ts#L21-L24, run https://github.com/me/s/actions/runs/9, repo me/p',
  );
  assert.throws(() => fillBody('{{CI_RUN}}', () => null), /no value for \{\{CI_RUN\}\}/);
  assert.equal(bodyOf('title: t\nlabels: l\n---\nbody line'), 'body line');
});

test('15-hydrate links another issue, a permalink and a CI run', () => {
  const body = bodyOf(readFileSync(dir('issues/15-hydrate.md'), 'utf8'));
  assert.match(body, /#\{\{ISSUE:01-wrong-month\.md\}\}/);
  assert.match(body, /\{\{PERMALINK:src\/list\.ts:21-24\}\}/);
  assert.match(body, /\{\{CI_RUN\}\}/);
});

test('both sandbox scripts build issue bodies through fill-body.mjs', () => {
  for (const f of ['setup-sandbox.sh', 'recreate-issue.sh']) assert.match(readFileSync(dir(f), 'utf8'), /node "\$here\/fill-body\.mjs" "\$f" "\$PWD" > "\$body"/, f);
});
