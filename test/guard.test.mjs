import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCommand, isActivating } from '../skills/ship/scripts/lib/guard.mjs';
import { tempDir, writeFiles } from './helpers/git.mjs';

const HOOK = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
const HOOKS_JSON = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));

// A pipeline home with one good run folder and several run folders whose vars.sh is wrong in
// one way each. RUN_DIR names are run-<id>, like mktemp's run-XXXXXX.
function makeHome(prefix = 'guard-') {
  const home = tempDir(prefix);
  writeFiles(home, {
    'runs/run-abc123/vars.sh': "set -u\nWT='/tmp/o'\\''neil/wt'\nBRANCH='claude/12-fix-month'\n",
    'runs/run-dq/vars.sh': 'set -u\nBRANCH="claude/3-double"\n',
    'runs/run-bare/vars.sh': 'set -u\nBRANCH=claude/4-bare\n',
    'runs/run-lastmain/vars.sh': "set -u\nBRANCH='claude/1-x'\nBRANCH='main'\n",
    'runs/run-subst/vars.sh': 'set -u\nBRANCH=$(echo main)\n',
    'runs/run-dqvar/vars.sh': 'set -u\nBRANCH="claude/$X"\n',
    'runs/run-nobranch/vars.sh': "set -u\nWT='/tmp/wt'\n",
    'runs/run-extra/vars.sh': "set -u\nBRANCH='claude/1-x'\nrm -rf x\n",
    'runs/run-semicolon/vars.sh': "set -u\nBRANCH='claude/1-x'; X=1\n",
    'runs/run-badref/vars.sh': "set -u\nBRANCH='claude/../main'\n",
    'runs/run-quote/vars.sh': "set -u\nBRANCH='claude/a'\\''b'\n",
    'runs/run-empty/vars.sh': 'set -u\nBRANCH=\n',
  });
  return home;
}

const varsFile = (home, id = 'abc123') => path.join(home, 'runs', `run-${id}`, 'vars.sh');
const source = (home, id) => `. '${varsFile(home, id)}'`;
const prefix = (home, id) => `${source(home, id)} && cd "$WT" && `;

const HOME = makeHome();
const SPACE_HOME = makeHome('guard space ');
const check = (command, home = HOME) => checkCommand(command, { home });

function assertAllowed(command, home = HOME) {
  const v = check(command, home);
  assert.equal(v.allow, true, `should allow: ${command} (${v.reason})`);
}

function assertDenied(command, reasonPattern, home = HOME) {
  const v = check(command, home);
  assert.equal(v.allow, false, `should deny: ${command}`);
  assert.equal(typeof v.reason, 'string', `reason for: ${command}`);
  assert.ok(v.reason.length > 0, `non-empty reason for: ${command}`);
  if (reasonPattern) assert.match(v.reason, reasonPattern, `reason for: ${command}`);
}

// --- checkCommand: allowed ---

test('allows the pipeline push commands', () => {
  for (const flags of ['', '-u ', '--set-upstream ']) {
    for (const ref of ['"$BRANCH"', '$BRANCH', '"${BRANCH}"', '${BRANCH}']) {
      assertAllowed(`${prefix(HOME)}git push ${flags}origin ${ref}`);
    }
  }
  assertAllowed(`${prefix(HOME)}git add -A && git commit -F "$RUN_DIR/commit-msg.txt" && git push origin "$BRANCH"`);
  assertAllowed(`${prefix(HOME)}git push origin "$BRANCH" 2>&1 | tail -5`);
  assertAllowed(`source '${varsFile(HOME)}' && git push origin "$BRANCH"`);
});

test('allows a literal claude/ branch, however it is quoted or spelled', () => {
  assertAllowed('git push origin claude/12-fix-month');
  assertAllowed("git push origin 'claude/12-fix-month'");
  assertAllowed('git push -u origin "claude/12-fix-month"');
  assertAllowed('/usr/bin/git push origin claude/1-x');
  assertAllowed('git push origin claude/1.2_x/y');
  assertAllowed('git push origin \\\nclaude/1-x');
  assertAllowed('git push origin claude/1-x # the run branch');
  assertAllowed('git push origin claude/1-x; echo done');
});

test('allows a push that redirects only to /dev/null or duplicates a descriptor', () => {
  assertAllowed('git push origin claude/1-x 2>&1');
  assertAllowed('git push origin claude/1-x >&2');
  assertAllowed('git push origin claude/1-x > /dev/null 2>&1');
  assertAllowed('git push origin claude/1-x &>/dev/null');
  assertAllowed('git push origin claude/1-x 2>/dev/null');
});

test('allows the commands the pipeline runs that have no push and no merge', () => {
  for (const command of [
    'gh pr list --repo o/r --json number,headRefName',
    'git merge --ff-only "origin/$BRANCH"',
    'gh pr view 5 --json mergeStateStatus,mergeable',
    'grep -rn push skills',
    'gh api -X POST "repos/$REPO/issues/3/sub_issues" -F sub_issue_id="$(gh api "repos/$REPO/issues/4" --jq .id)"',
    'gh api repos/o/r/contents/README.md',
    'gh api -X GET repos/o/r/contents/README.md',
    'git status --porcelain',
    `${prefix(HOME)}git commit -F "$RUN_DIR/commit-msg.txt"`,
    'echo "a (quoted) ) paren" && ls',
    "cat <<'EOF'\nhello\nEOF",
  ]) {
    assertAllowed(command);
  }
});

test('works in a pipeline home whose path contains a space', () => {
  assert.ok(SPACE_HOME.includes(' '));
  assertAllowed(`${prefix(SPACE_HOME)}git push origin "$BRANCH"`, SPACE_HOME);
  assertAllowed(`${prefix(SPACE_HOME)}git push -u origin "${'$'}{BRANCH}"`, SPACE_HOME);
  assertDenied(`${prefix(SPACE_HOME)}git push origin main`, /claude\//, SPACE_HOME);
  assertDenied(`. '${varsFile(HOME)}' && git push origin "$BRANCH"`, null, SPACE_HOME);
});

test('resolves $BRANCH from a double-quoted or bare vars.sh value', () => {
  assertAllowed(`${source(HOME, 'dq')} && git push origin "$BRANCH"`);
  assertAllowed(`${source(HOME, 'bare')} && git push origin "$BRANCH"`);
});

// --- checkCommand: branch and flag problems ---

test('denies pushes of anything but one claude/ branch to origin', () => {
  const denied = [
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin +claude/1-x',
    'git push origin claude/1-x:main',
    'git push origin :claude/1-x',
    'git push origin claude/../main',
    'git push origin claude/1-x.lock',
    'git push origin claude/1-x/',
    'git push origin claude/',
    'git push origin claude/*',
    'git push origin claude/{a,b}',
    'git push origin claude/$X',
    'git push origin $X',
    "git push origin $'claude/1-x'",
    "git push origin '$BRANCH'",
    'git push origin claude/1-x claude/2-y',
    'git push --force origin "$BRANCH"',
    'git push -f origin claude/1-x',
    'git push -fu origin claude/1-x',
    'git push --force-with-lease origin claude/1-x',
    'git push --force-with-lease=main origin claude/1-x',
    'git push --mirror origin',
    'git push --all origin',
    'git push --tags origin',
    'git push origin --delete claude/1-x',
    'git push -d origin claude/1-x',
    'git push',
    'git push origin',
    'git push -u origin',
    'git push origin claude/1-x --no-verify',
    'git push origin -u claude/1-x',
    'git push -u -u origin claude/1-x',
    'git push upstream claude/1-x',
    'git push "$REMOTE" claude/1-x',
    'git -C "$WT" push origin claude/1-x',
    'git -c core.hooksPath=/dev/null push origin claude/1-x',
    'GIT_DIR=x git push origin claude/1-x',
    'GIT_SSH_COMMAND=x git push origin claude/1-x',
    'git stash push',
    'git push origin claude/1-x > out.txt',
    'git push origin claude/1-x >> /tmp/x',
    'git push origin claude/1-x 2>/tmp/err',
    'git push origin claude/1-x; git push origin main',
    'git push origin claude/1-x\ngit push origin main',
    'cd x && git push origin claude/1-x & git push origin main',
  ];
  for (const command of denied) assertDenied(command);
});

test('names the problem in the reason for representative pushes', () => {
  assertDenied('git push --force origin "$BRANCH"', /force/i);
  assertDenied('git push origin +claude/1-x', /force/i);
  assertDenied('git push origin HEAD:main', /claude\//);
  assertDenied('git push upstream claude/1-x', /origin/);
  assertDenied('git -C x push origin claude/1-x', /options before push/);
  assertDenied('git push origin claude/1-x claude/2-y', /refspec/);
});

// --- checkCommand: $BRANCH that can't be trusted ---

test('denies $BRANCH when vars.sh was not sourced from the run folder', () => {
  const push = 'git push origin "$BRANCH"';
  assertDenied(`cd "$WT" && ${push}`, /vars\.sh/);
  assertDenied(`${source(HOME)} && ${source(HOME)} && ${push}`, /more than one/);
  assertDenied(`. "$RUN_DIR/vars.sh" && ${push}`);
  assertDenied(`. '/tmp/elsewhere/runs/run-abc123/vars.sh' && ${push}`);
  assertDenied(`. '${path.join(HOME, 'vars.sh')}' && ${push}`);
  assertDenied(`. '${path.join(HOME, 'runs', 'vars.sh')}' && ${push}`);
  assertDenied(`. '${path.join(HOME, 'runs', 'run-abc123', 'sub', 'vars.sh')}' && ${push}`);
  assertDenied(`. '${path.join(HOME, 'runs', 'run-abc123', '..', '..', 'vars.sh')}' && ${push}`);
  assertDenied(`. '${path.join(HOME, 'runs', 'run-a.b', 'vars.sh')}' && ${push}`);
  assertDenied(`. 'runs/run-abc123/vars.sh' && ${push}`);
  assertDenied(`. '${varsFile(HOME)}' extra && ${push}`);
  assertDenied(`. '${varsFile(HOME, 'nosuchrun')}' && ${push}`);
  assertDenied(`. ~/.claude-pipeline/runs/run-abc123/vars.sh && ${push}`);
});

test('denies a relative vars.sh path even when it would resolve into the run folder', (t) => {
  // The hook resolves a relative path against its own cwd, which can differ from the shell's.
  const before = process.cwd();
  t.after(() => process.chdir(before));
  process.chdir(HOME);
  assertDenied('. runs/run-abc123/vars.sh && git push origin "$BRANCH"', /absolute/);
});

test('denies $BRANCH when something in the command could change it', () => {
  const s = source(HOME);
  const push = 'git push origin "$BRANCH"';
  for (const command of [
    `${s} && BRANCH=main; ${push}`,
    `${s} && BRANCH+=x; ${push}`,
    `${s} && BRANCH[0]=main; ${push}`,
    `${s} && export BRANCH=main && ${push}`,
    `${s} && declare -x BRANCH=main && ${push}`,
    `${s} && eval x && ${push}`,
    `${s} && unset BRANCH && ${push}`,
    `${s} && read BRANCH && ${push}`,
    `${s} && printf -v BRANCH main && ${push}`,
    `${s} && printf -vBRANCH main && ${push}`,
    `${s} && for BRANCH in main; do :; done; ${push}`,
    `${s} && getopts x BRANCH && ${push}`,
    `${s} && echo main | { read BRANCH; ${push}; }`,
    `${s} && set -- x && ${push}`,
    `${s} && alias git=true && ${push}`,
    `${s} && command true && ${push}`,
    `${s} && exec true && ${push}`,
    `${s} && trap true EXIT && ${push}`,
    `${s} && X=1 eval x && ${push}`,
    `${s} && $(true) && ${push}`,
    `${s} && echo \`true\` && ${push}`,
    `${s} && echo "BRANCH='main'" >> '${varsFile(HOME)}' && ${push}`,
    `echo "BRANCH='main'" >> '${varsFile(HOME)}' && ${push}`,
    `${s} && ${push} && cat '${varsFile(HOME)}'`,
    `${s} && sed -i x "$RUN_DIR/vars.sh" && ${push}`,
  ]) {
    assertDenied(command);
  }
  assertDenied(`${s} && BRANCH=main; ${push}`, /BRANCH/);
  assertDenied(`${s} && $(true) && ${push}`, /substitution/);
});

test('denies $BRANCH when vars.sh does not name a safe claude/ branch', () => {
  const push = 'git push origin "$BRANCH"';
  for (const id of ['lastmain', 'subst', 'dqvar', 'nobranch', 'extra', 'semicolon', 'badref', 'quote', 'empty']) {
    assertDenied(`${source(HOME, id)} && ${push}`, null);
  }
});

test('reads vars.sh through the readFile it is given', () => {
  const command = `${source(HOME)} && git push origin "$BRANCH"`;
  const seen = [];
  const reader = (body) => (file) => { seen.push(file); return body; };
  const ok = checkCommand(command, { home: HOME, readFile: reader("BRANCH='claude/9-z'\n") });
  assert.equal(ok.allow, true);
  assert.deepEqual(seen, [varsFile(HOME)]);
  const bad = checkCommand(command, { home: HOME, readFile: reader("BRANCH='main'\n") });
  assert.equal(bad.allow, false);
  const missing = checkCommand(command, { home: HOME, readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(missing.allow, false);
  assert.ok(missing.reason.length > 0);
});

// --- checkCommand: catch-all ---

test('denies a push the guard cannot check', () => {
  const denied = [
    'bash -c "git push origin main"',
    "sh -c 'git push origin claude/1-x'",
    `node -e "require('child_process').execSync('git push origin main')"`,
    'git config alias.p push',
    'command git push origin claude/1-x',
    'env X=1 git push origin claude/1-x',
    'git commit -m "push the fix"',
    "git push origin 'claude/1-x",
    'echo $(git push origin claude/1-x)',
    'echo `git push origin claude/1-x`',
    'true && (cd x; GIT_DIR=y git push origin main)',
    'if true; then git push origin claude/1-x; fi',
    'xargs git push origin < branches.txt',
    'git push origin claude/1-x <<< "git push origin main"',
    "cat <<EOF | git push origin main\nx\nEOF",
    'git push origin claude/1-x # git push origin main',
    'echo hi | sudo git push origin claude/1-x',
    'git push origin "$BRANCH\nx',
  ];
  for (const command of denied) assertDenied(command);
  assertDenied("git push origin 'claude/1-x", /too complex/);
  assertDenied('bash -c "git push origin main"', /can't check/);
});

// --- checkCommand: merges and ref writes ---

test('denies merging and writing refs through gh and the API', () => {
  const denied = [
    'gh pr merge 5 --squash',
    'gh pr merge --auto 5',
    'gh  pr   merge 5',
    'bash -c "gh pr merge 5"',
    'gh alias set m \'pr merge\'',
    'gh alias list',
    'gh api -X PUT repos/o/r/pulls/5/merge',
    'gh api repos/o/r/pulls/5/merge --method PUT',
    'gh api repos/o/r/merges -f base=main -f head=claude/1-x',
    `gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { createCommitOnBranch(input:{}) { commit { oid } } }'`,
    `gh api graphql -f query='mutation { updateRef(input:{}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { updateRefs(input:{}) { clientMutationId } }'`,
    'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc',
    'gh api repos/o/r/git/refs/heads/main',
    'gh api repos/o/r/git/commits -f message=x',
    'gh api repos/o/r/git/trees -f base_tree=x',
    'gh api repos/o/r/git/tags -f tag=x',
    'gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA==',
    'gh api repos/o/r/contents/README.md -X DELETE',
    'gh api repos/o/r/contents/README.md --method=PUT',
    'gh api repos/o/r/contents/README.md -XPOST',
    'gh api repos/o/r/contents/README.md --input body.json',
    'gh api repos/o/r/contents/README.md --raw-field message=x',
    'gh api repos/o/r/contents/README.md --field message=x',
    'gh api repos/o/r/contents/README.md -F message=x',
  ];
  for (const command of denied) assertDenied(command);
  assertDenied('gh pr merge 5 --squash', /merg/i);
  assertDenied('gh api -X PUT repos/o/r/pulls/5/merge', /merge/);
  assertDenied('gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc', /refs/);
  assertDenied('gh api -X PUT repos/o/r/contents/README.md -f message=x', /contents/);
});

// --- isActivating ---

test('isActivating recognises pipeline commands', () => {
  const home = '/srv/pipeline-home';
  assert.equal(isActivating('echo $CLAUDE_PIPELINE_HOME', home), true);
  assert.equal(isActivating('ls ~/.claude-pipeline/runs/run-x', home), true);
  assert.equal(isActivating('. /srv/pipeline-home/runs/run-x/vars.sh', home), true);
  assert.equal(isActivating('. /srv/pipeline-home/runs/run-x/vars.sh', `${home}/`), true);
  assert.equal(isActivating('node /p/skills/ship/scripts/pipeline.mjs config', home), true);
  assert.equal(isActivating('git push origin main', home), false);
  assert.equal(isActivating('ls /srv/other/runs/', home), false);
  assert.equal(isActivating('gh pr list', home), false);
});

// --- hook wrapper ---

function runHook({ home, guard, input }) {
  const env = { ...process.env, CLAUDE_PIPELINE_HOME: home };
  if (guard === undefined) delete env.CLAUDE_PIPELINE_GUARD;
  else env.CLAUDE_PIPELINE_GUARD = guard;
  const r = spawnSync(process.execPath, [HOOK], { input, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const bashInput = (command, session) => JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  ...(session === undefined ? {} : { session_id: session }),
});

test('hook: does nothing while the guard is not active', () => {
  const home = makeHome('guard-off-');
  const r = runHook({ home, input: bashInput('git push origin main', 'sx') });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.equal(existsSync(path.join(home, 'guard')), false);
});

test('hook: CLAUDE_PIPELINE_GUARD=1 keeps the guard on and blocks with exit 2', () => {
  const home = makeHome('guard-on-');
  const r = runHook({ home, guard: '1', input: bashInput('git push origin main', 'sx') });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith('claude-pipeline guard:'), r.stderr);
  assert.match(r.stderr, /stop procedure/);
  assert.match(r.stderr, /git push origin "\$BRANCH"/);
  const ok = runHook({ home, guard: '1', input: bashInput('git push origin claude/1-x', 'sx') });
  assert.equal(ok.code, 0);
  assert.equal(ok.stderr, '');
});

test('hook: CLAUDE_PIPELINE_GUARD=0 switches it off even for a pipeline command', () => {
  const home = makeHome('guard-zero-');
  const command = `${source(home)} && git push origin main`;
  const r = runHook({ home, guard: '0', input: bashInput(command, 's1') });
  assert.equal(r.code, 0);
  assert.equal(existsSync(path.join(home, 'guard', 's1')), false);
});

test('hook: a pipeline command switches the guard on for its own session only', () => {
  const home = makeHome('guard-session-');
  const setup = runHook({ home, input: bashInput(`${source(home)} && node "$PIPELINE" config`, 's1') });
  assert.equal(setup.code, 0);
  const marker = path.join(home, 'guard', 's1');
  assert.ok(existsSync(marker), 'marker file');
  assert.match(readFileSync(marker, 'utf8'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);

  assert.equal(runHook({ home, input: bashInput('git push origin main', 's1') }).code, 2);
  assert.equal(runHook({ home, input: bashInput('git push origin main', 's2') }).code, 0);
  assert.equal(runHook({ home, input: bashInput('git push origin main') }).code, 0);
});

test('hook: an activating command is checked in the same call, even without a session id', () => {
  const home = makeHome('guard-nosession-');
  const r = runHook({ home, input: bashInput(`${source(home)} && git push origin main`) });
  assert.equal(r.code, 2);
  assert.equal(existsSync(path.join(home, 'guard')), false, 'no marker without a session id');
});

test('hook: marker file names are sanitised and old markers are pruned', () => {
  const home = makeHome('guard-prune-');
  const guardDir = path.join(home, 'guard');
  writeFiles(guardDir, { old: 'x', recent: 'x' });
  writeFiles(home, { 'outside-guard': 'keep' });
  const old = new Date(Date.now() - 15 * 24 * 3600 * 1000);
  utimesSync(path.join(guardDir, 'old'), old, old);
  utimesSync(path.join(home, 'outside-guard'), old, old);

  const r = runHook({ home, input: bashInput(`${source(home)} && echo hi`, 'a/../b') });
  assert.equal(r.code, 0);
  assert.ok(existsSync(path.join(guardDir, 'a____b')), 'sanitised marker');
  assert.equal(existsSync(path.join(guardDir, 'old')), false, 'old marker pruned');
  assert.ok(existsSync(path.join(guardDir, 'recent')), 'recent marker kept');
  assert.ok(existsSync(path.join(home, 'outside-guard')), 'pruning stays inside guard/');
});

test('hook: ignores other tools and input it cannot read', () => {
  const home = makeHome('guard-other-');
  const cases = [
    JSON.stringify({ tool_name: 'Read', tool_input: { command: 'git push origin main' } }),
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } }),
    JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
    JSON.stringify({ tool_name: 'Bash' }),
    JSON.stringify(null),
    '{ not json',
    '',
  ];
  for (const input of cases) {
    const r = runHook({ home, guard: '1', input });
    assert.equal(r.code, 0, `input: ${input}`);
    assert.equal(r.stderr, '');
  }
});

test('hooks.json registers the guard as a PreToolUse hook on Bash', () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const entry = config.hooks.PreToolUse.find((e) => e.matcher === 'Bash');
  assert.ok(entry, 'PreToolUse entry with matcher Bash');
  const hook = entry.hooks[0];
  assert.equal(hook.type, 'command');
  assert.ok(hook.command.includes('${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs'), hook.command);
  assert.ok(existsSync(HOOK));
});
