import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
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
const ONLY_AROUND = /only the vars\.sh source, cd, git add, git commit and git status/;

function assertAllowed(command, home = HOME) {
  const v = check(command, home);
  assert.equal(v.allow, true, `should allow: ${command} (${v.reason})`);
}

function assertDenied(command, reasonPattern, home = HOME) {
  const v = check(command, home);
  assert.equal(v.allow, false, `should deny: ${command}`);
  assert.equal(typeof v.reason, 'string', `reason for: ${command}`);
  assert.ok(v.reason.length > 0, `non-empty reason for: ${command}`);
  assert.ok(['reshape', 'forbidden'].includes(v.kind), `kind for: ${command} (${v.kind})`);
  if (reasonPattern) assert.match(v.reason, reasonPattern, `reason for: ${command}`);
}

// 'reshape': the push is fine and only what surrounds it is wrong, so the agent can split the
// command. 'forbidden': anything else, so the agent should stop.
function assertKind(command, kind, home = HOME) {
  const v = check(command, home);
  assert.equal(v.allow, false, `should deny: ${command}`);
  assert.equal(v.kind, kind, `kind for: ${command} (${v.reason})`);
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
  assertAllowed('git push origin claude/1-x\n');
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
  assertDenied(`${source(HOME)} && ${source(HOME)} && ${push}`, ONLY_AROUND);
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
  assertDenied(`${s} && BRANCH=main; ${push}`, ONLY_AROUND);
  assertDenied(`${s} && $(true) && ${push}`, ONLY_AROUND);
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

// --- checkCommand: a command that pushes may contain nothing else (16a fix round 1) ---

test('denies a command that rewrites vars.sh (by glob or by cp) before sourcing it and pushing', () => {
  const v = varsFile(HOME);
  const glob = v.replace('vars.sh', "vars'?'sh");
  const star = v.replace('vars.sh', "va'*'.sh");
  const push = 'git push origin "$BRANCH"';
  for (const command of [
    `printf '\\nBRANCH=claude/12-fix-month:main\\n' > '${glob}' && ${source(HOME)} && cd "$WT" && ${push}`,
    `printf '\\nBRANCH=claude/12-fix-month:main\\n' > '${star}' && ${source(HOME)} && cd "$WT" && ${push}`,
    `cp evil '${star}' && ${source(HOME)} && cd "$WT" && ${push}`,
    `${source(HOME)} && printf x > '${glob}' && ${push}`,
    `${source(HOME)} && cp evil '${star}' && ${push}`,
    `${source(HOME)} && cd "$WT" && ${push} 2>&1 | tail -5 > out.txt`,
  ]) {
    assertDenied(command, ONLY_AROUND);
  }
  assertDenied(`${source(HOME)} && cd "$WT" && ${push} > out.txt`, /redirection/);
});

test('denies a push whose command has a source that is not first, or a shape the whitelist lacks', () => {
  const s = source(HOME);
  const push = 'git push origin "$BRANCH"';
  for (const command of [
    `{ ${s}; } && ${push}`,
    `if true; then ${s}; fi; ${push}`,
    `(${s}) && ${push}`,
    `false && ${s}; ${push}`,
    `${push}; ${s}`,
    `cd "$WT" && ${s} && ${push}`,
    `${s} && echo \${X:-$(true)} && ${push}`,
    `${s} && echo \${X:-\`true\`} && ${push}`,
    `${s} && export GIT_CONFIG_COUNT=1 && git push origin claude/1-x`,
    `${s} && ls && ${push}`,
    `echo hi && git push origin claude/1-x`,
    // every segment is one the whitelist knows; only the joiner, a substitution or an assignment is wrong
    `git status; git push origin claude/1-x`,
    `git status || git push origin claude/1-x`,
    `git status | git push origin claude/1-x`,
    `cd /tmp & git push origin claude/1-x`,
    `git status\ngit push origin claude/1-x`,
    `git status && git push origin claude/1-x ; git status`,
    `git add $(ls) && git push origin claude/1-x`,
    `cd "$(pwd)" && git push origin claude/1-x`,
    'git add `ls` && git push origin claude/1-x',
    `git add \${X:-$(true)} && git push origin claude/1-x`,
    `git add \${X:-\`true\`} && git push origin claude/1-x`,
    `git add -A && git commit -m "$(cat msg.txt)" && git push origin claude/1-x`,
    `git push origin claude/1-x && git commit -m x > out.txt`,
    `GIT_DIR=/tmp/x git add -A && git push origin claude/1-x`,
    `git push origin claude/1-x; true`,
    `git push origin claude/1-x || true`,
    `git push origin claude/1-x &`,
    `git push origin claude/1-x; echo done`,
    `git push origin claude/1-x\necho done`,
    `git push origin claude/1-x && (true)`,
    `X=1 git status && git push origin claude/1-x`,
    `cd a b && git push origin claude/1-x`,
    `cd && git push origin claude/1-x`,
    `git -C x status && git push origin claude/1-x`,
    `git log && git push origin claude/1-x`,
    `git push origin claude/1-x | cat`,
    `git push origin claude/1-x | tail $(echo 5)`,
    `git push origin claude/1-x | tail -f /etc/hosts`,
    `git push origin claude/1-x | tail -5 | head -1`,
    `tail -5 && git push origin claude/1-x`,
    `true | tail -5 && git push origin claude/1-x`,
    `git push origin claude/1-x && ! true`,
    `git push origin claude/1-x && \`true\``,
    `${s} extra && ${push}`,
    `X=1 . '${varsFile(HOME)}' && ${push}`,
    `git commit --no-verify -m x && git push origin claude/1-x`,
    `git commit -n -m x && git push origin claude/1-x`,
    `git commit -nm x && git push origin claude/1-x`,
    `git commit -m x --no-verif && git push origin claude/1-x`,
    `git commit -m x >out.txt && git push origin claude/1-x`,
  ]) {
    assertDenied(command);
  }
  assertDenied(`git push origin claude/1-x; true`, ONLY_AROUND);
  assertDenied(`${s} && export GIT_CONFIG_COUNT=1 && git push origin claude/1-x`, ONLY_AROUND);
});

// --- checkCommand: reshape or forbidden (16a round 2) ---

test('a harmless command around a good push is a reshape denial', () => {
  const s = source(HOME);
  const push = 'git push origin "$BRANCH"';
  for (const command of [
    `${s} && cd "$WT" && ${push} > out.txt`,
    'git push origin claude/1-x > out.txt',
    'git push origin claude/1-x; true',
    'git push origin claude/1-x || true',
    'git push origin claude/1-x &',
    'git push origin claude/1-x\necho done',
    '(git push origin claude/1-x)',
    `${s} && cd "$WT" && ${push} && cp a b`,
    `${s} && cd "$WT" && ${push} 2>&1 | tail -5 > out.txt`,
    `${s} && ${push} | cat`,
    `${s} && ${push} && echo "$(date)"`,
    'git add -A && git commit -F f && git push origin claude/1-x && echo done',
    // only the joiner is wrong, between segments that are all allowed
    'git status; git push origin claude/1-x',
    // the source is missing, or not first, but everything before the push is allowed
    `cd "$WT" && ${push}`,
    `cd "$WT" && ${s} && ${push}`,
    `git add -A && ${s} && ${push}`,
    `${push}; ${s}`,
    `${s} && ${s} && ${push}`,
  ]) {
    assertKind(command, 'reshape');
  }
  assertDenied(`${s} && cd "$WT" && ${push} && cp a b`, ONLY_AROUND);
});

test('anything that could change what is pushed, or a bad push, is a forbidden denial', () => {
  const s = source(HOME);
  const push = 'git push origin "$BRANCH"';
  const glob = varsFile(HOME).replace('vars.sh', "vars'?'sh");
  for (const command of [
    // something outside the whitelist runs before the push
    `${s} && cp a b && git add -A && git commit -F f && ${push}`,
    `printf '\nBRANCH=claude/12-fix-month:main\n' > '${glob}' && ${s} && cd "$WT" && ${push}`,
    `${s} && printf x > '${glob}' && ${push}`,
    `${s} && git status > out.txt && ${push}`,
    `${s} && git add $(ls) && ${push}`,
    `${s} && X=1 git add -A && ${push}`,
    `${s} && export GIT_CONFIG_COUNT=1 && git push origin claude/1-x`,
    `${s} && echo hi && ${push}`,
    `false && ${s}; ${push}`,
    `{ ${s}; } && ${push}`,
    `git commit --no-verify -m x && git push origin claude/1-x`,
    // the push itself is wrong
    'git push origin main',
    'git push origin claude/1-x:main',
    'git push --force origin claude/1-x',
    'git push upstream claude/1-x',
    'git -C x push origin claude/1-x',
    'GIT_DIR=x git push origin claude/1-x',
    'git push origin claude/1-x && git push origin main',
    'git push origin claude/1-x > out.txt; git push origin main',
    // $BRANCH that can't be trusted, even with only trailing problems
    `${source(HOME, 'lastmain')} && ${push}`,
    `${source(HOME, 'lastmain')} && ${push}; true`,
    `${source(HOME, 'subst')} && ${push} && cp a b`,
    `. '/tmp/x/runs/run-abc123/vars.sh' && ${push}`,
    `. '/tmp/x/vars.sh' && git push origin claude/1-x`,
    `. "$RUN_DIR/vars.sh" && ${push}; true`,
    // merges, API writes, remotes and config
    'gh pr merge 5',
    'git push origin claude/1-x; gh pr merge 5',
    'gh api -X PUT repos/o/r/pulls/5/merge',
    'git remote set-url origin x',
    'git config core.hooksPath /tmp/h',
    // a push hidden where the guard can't check it, or a command it can't read
    'git push origin claude/1-x; bash -c "git push origin main"',
    "git push origin 'claude/1-x",
    'git push origin claude/1-x <<< "x"',
  ]) {
    assertKind(command, 'forbidden');
  }
});

test('an unparseable command still gets the remote and config rules', () => {
  for (const command of [
    'cat <<EOF\nx\nEOF\ngit remote add evil x',
    'git remote set-url origin https://evil.example/x.git <<< x',
    'git REMOTE\tSet-Url origin x <<EOF\nx\nEOF',
    'git remote rm origin <<< x',
    'git config remote.origin.pushurl x <<EOF\nx\nEOF',
    'git config --global url.https://evil.example/.insteadOf https://github.com/ <<< x',
    'git config core.hooksPath /tmp/h <<< x',
    'git config core.sshCommand evil <<< x',
    'git config alias.p !evil <<< x',
    'git config credential.helper store <<< x',
    "git config http.proxy x 'unbalanced",
  ]) {
    assertKind(command, 'forbidden');
  }
  assertAllowed('cat <<EOF\nx\nEOF\ngit remote -v');
  assertAllowed('git config user.name <<< x');
  assertAllowed('git remote get-url origin <<< x');
});

test('denies a literal push sourced from a vars.sh outside the run folder', () => {
  assertDenied('. /tmp/x/vars.sh && git push origin claude/1-x', /vars\.sh/);
  assertAllowed(`${source(HOME)} && git push origin claude/1-x`);
});

test('allows only vars.sh source, cd, git add, git commit, git status and tail/head around a push', () => {
  const p = prefix(HOME);
  for (const command of [
    `${p}git status --porcelain && git push -u origin "$BRANCH"`,
    `${p}git add docs/pipeline/$KEY && git commit -m "docs(pipeline): spec for #12" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git push -u origin "$BRANCH"`,
    `${p}git add -A && git commit -m "wip(pipeline): 12 stopped at stage 3" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git push origin "$BRANCH"`,
    `${p}git add -A && git commit -F "$RUN_DIR/commit-msg.txt" && git push origin "$BRANCH"`,
    `${p}git add -A && git commit -mnote && git push origin "$BRANCH"`,
    `${p}git commit -m "-n is not a flag here" && git push origin "$BRANCH"`,
    `${p}git push origin "$BRANCH" 2>&1 | tail -5`,
    `${p}git push origin "$BRANCH" 2>&1 | head -n 20`,
    `${p}git push origin "$BRANCH" 2>&1 | tail -n +3 && git status`,
    `${source(HOME)} && git push origin "$BRANCH"`,
    'git push origin claude/12-fix-month',
    'cd /tmp && git push origin claude/12-fix-month',
    'git status && git push origin claude/12-fix-month',
  ]) {
    assertAllowed(command);
  }
});

test('allows every push the skill documents, in the form the skill gives it', () => {
  const skillDir = fileURLToPath(new URL('../skills/ship/', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'scripts') walk(full); } else if (name.endsWith('.md')) files.push(full);
    }
  };
  walk(skillDir);
  let seen = 0;
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/`([^`\n]*git push[^`\n]*)`/g)) {
      seen += 1;
      assertAllowed(`${prefix(HOME)}${m[1]}`);
    }
  }
  assert.ok(seen >= 10, `expected to find the documented pushes, found ${seen}`);
});

// --- checkCommand: changing remotes and push-related config ---

test('denies changing git remotes and the git config that controls pushes', () => {
  for (const command of [
    'git remote set-url origin https://evil.example/x.git',
    'git remote add evil x',
    'git remote rename origin x',
    'git remote remove origin',
    'git remote rm origin',
    'git remote set-branches origin main',
    'git -C "$WT" remote add evil x',
    'git config url.https://evil.example/.insteadOf https://github.com/',
    'git config remote.origin.pushurl x',
    'git config --global alias.p push',
    'git config core.hooksPath /tmp/h',
    'git config core.sshCommand evil',
    'git config --unset remote.origin.url',
    'git config --unset-all core.hooksPath',
    'git config --local --add remote.origin.url x',
    'git config credential.helper store',
    'git config http.proxy x',
    'git config includeIf.gitdir:/x.path /y',
    'git config branch.main.remote x',
    'git config PUSH.default matching',
  ]) {
    assertDenied(command);
  }
  assertDenied('git remote set-url origin https://evil.example/x.git', /remotes/);
  assertDenied('git config core.hooksPath /tmp/h', /config/);
});

test('allows reading remotes and config, and config that does not steer pushes', () => {
  for (const command of [
    'git remote -v',
    'git remote get-url origin',
    'git remote prune origin',
    'git remote set-head origin --auto',
    'git config --get remote.origin.url',
    'git config --get-all remote.origin.fetch',
    'git config --get-regexp remote',
    'git config --list',
    'git config -l',
    'git config user.name',
    'git config user.name "A Name"',
    'git config core.editor true',
  ]) {
    assertAllowed(command);
  }
});

// --- checkCommand: fewer false positives ---

test('does not mistake files and identifiers that contain push, git or merge for a push or a merge', () => {
  for (const command of [
    'git add src/push.ts && git commit -F "$RUN_DIR/commit-msg.txt"',
    'git diff -- src/push-notifications.ts',
    "git grep -n '.push('",
    `. '${varsFile(HOME)}' && echo "BRANCH='claude/12-git-push-hook'" >> "$RUN_DIR/vars.sh"`,
    'git add lib/git/refs.js',
    'grep -rn updateRef src',
    'git add docs/merges.md',
    'git add docs/git/commits.md docs/git/tags.md',
    'cat pulls/5/merge-notes.md',
    'npm run push-docs',
    'echo pushed && git status',
    'git log --oneline -- lib/pushers.js',
  ]) {
    assertAllowed(command);
  }
});

test('still denies a standalone push next to git, in any case', () => {
  for (const command of [
    'git status && echo PUSH',
    'echo "(push)" && git status',
    'echo {push} && git status',
    "git log --grep='push'",
    'git commit -m "push the fix"',
    'bash -c "git push origin main"',
    "sh -c 'git push origin claude/1-x'",
    'echo x;git;push',
    '/usr/bin/git log --grep="Push"',
  ]) {
    assertDenied(command);
  }
});

test('applies the GraphQL and API rules only to GraphQL queries and API endpoint paths', () => {
  assertDenied('gh api graphql -f query=\'mutation { mergeBranch(input:{}) { clientMutationId } }\'');
  assertDenied('gh api GraphQL -f query=@q.txt -f x=updateRef');
  assertDenied('gh api "repos/$REPO/pulls/5/merge" -X PUT', /merge API/);
  assertDenied('gh api /repos/o/r/merges -f base=main', /merge API/);
  assertDenied('gh api "repos/$REPO/git/refs" -f ref=x', /refs/);
  assertDenied('gh api "repos/$REPO/contents/x.md" -X PUT', /contents/);
  assertAllowed('gh api "repos/$REPO/contents/x.md" --jq .content');
  assertAllowed('gh api "repos/$REPO/pulls/5/comments"');
  assertAllowed('cat docs/git/refs.md docs/merges.md lib/contents/x.js -f');
});

test('denies gh pr merge however it is spelled', () => {
  for (const command of [
    'gh pr -R o/r merge 5 --squash',
    'gh pr "merge" 5',
    "gh pr 'merge' --auto 5",
    'GH pr merge 5',
    '/usr/local/bin/gh pr --repo o/r "merge" 5',
    'gh pr\tmerge 5',
  ]) {
    assertDenied(command, /merg/i);
  }
  assertAllowed('gh pr view 5 --json mergeable');
  assertAllowed('gh pr view 5 --json mergeStateStatus,mergeable');
  assertAllowed('gh pr list --search "merged"');
});

test('denies a push through a git spelled with another case, a glob or an expansion', () => {
  for (const command of [
    'GIT push origin main',
    '/usr/bin/Git push origin main',
    '/usr/bin/gi? push origin main',
    '/usr/bin/gi[t] push origin claude/1-x',
    '/usr/bin/g* push origin claude/1-x',
    '$GIT push origin claude/1-x',
    '"$GIT" push origin claude/1-x',
    '$HOME/bin/git push origin claude/1-x',
  ]) {
    assertDenied(command);
  }
  assertAllowed('GIT status && git push origin claude/1-x');
  assertAllowed('/usr/bin/Git push origin claude/1-x');
});

// --- isActivating ---

// The Setup command exactly as SKILL.md gives it.
const SETUP_COMMAND = readFileSync(fileURLToPath(new URL('../skills/ship/SKILL.md', import.meta.url)), 'utf8')
  .match(/`(mkdir -p [^`\n]*mktemp -d[^`\n]*)`/)?.[1];

test('isActivating recognises the Setup command and a source of a run\'s vars.sh, and nothing else', () => {
  assert.ok(SETUP_COMMAND, 'SKILL.md Setup command not found');
  assert.equal(isActivating(SETUP_COMMAND), true);
  assert.equal(isActivating('RUN_DIR=$(mktemp -d "$H/runs/run-XXXXXX")'), true);
  assert.equal(isActivating('. /srv/pipeline-home/runs/run-x1/vars.sh && node "$PIPELINE" config'), true);
  assert.equal(isActivating(". '/srv/pipeline home/runs/run-AbC123/vars.sh' && git status"), true);
  for (const command of [
    'ls ~/.claude-pipeline/runs/',
    'ls ~/.claude-pipeline/runs/run-x1',
    'grep -rn CLAUDE_PIPELINE_HOME .',
    'echo $CLAUDE_PIPELINE_HOME',
    'node /p/skills/ship/scripts/pipeline.mjs config',
    'cat /srv/x/runs/run-abc/notes.txt',
    'cat /srv/x/runs/run-a.b/vars.sh',
    'git push origin main',
    'gh pr list',
  ]) {
    assert.equal(isActivating(command), false, command);
  }
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

test('hook: a reshape denial tells the agent to split the command; a forbidden one says to stop', () => {
  const home = makeHome('guard-kinds-');
  const reshape = runHook({ home, guard: '1', input: bashInput('git push origin claude/1-x; true') });
  assert.equal(reshape.code, 2);
  assert.ok(reshape.stderr.startsWith('claude-pipeline guard: '), reshape.stderr);
  assert.match(reshape.stderr, /Split the command: run the push on its own as `\. '<RUN_DIR>\/vars\.sh' && cd "\$WT" && git push origin "\$BRANCH"` \(use `-u` if this is the branch's first push\), with only `git add`, `git commit` and `git status` allowed before it\. Do everything else in a separate command\./);
  assert.doesNotMatch(reshape.stderr, /stop procedure/);
  assert.doesNotMatch(reshape.stderr, /CLAUDE_PIPELINE_GUARD/);

  const forbidden = runHook({ home, guard: '1', input: bashInput('git push origin main') });
  assert.equal(forbidden.code, 2);
  assert.match(forbidden.stderr, /follow the stop procedure/);
  assert.doesNotMatch(forbidden.stderr, /Split the command/);

  // a cp between the source and the push is forbidden, and a cp after it is a reshape
  const between = runHook({ home, guard: '1', input: bashInput(`${source(home)} && cp a b && git push origin "$BRANCH"`) });
  assert.match(between.stderr, /follow the stop procedure/);
  const after = runHook({ home, guard: '1', input: bashInput(`${source(home)} && git push origin "$BRANCH" && cp a b`) });
  assert.match(after.stderr, /Split the command/);
});

test('hook: the Setup command switches the guard on; merely mentioning the pipeline home does not', () => {
  const home = makeHome('guard-setup-');
  const quiet = runHook({ home, input: bashInput('grep -rn CLAUDE_PIPELINE_HOME . && ls ~/.claude-pipeline/runs/', 's5') });
  assert.equal(quiet.code, 0);
  assert.equal(existsSync(path.join(home, 'guard', 's5')), false);
  assert.equal(runHook({ home, input: bashInput('git push origin main', 's5') }).code, 0);

  const setup = runHook({ home, input: bashInput(SETUP_COMMAND, 's6') });
  assert.equal(setup.code, 0, setup.stderr);
  assert.ok(existsSync(path.join(home, 'guard', 's6')), 'marker file');
  assert.equal(runHook({ home, input: bashInput('git push origin main', 's6') }).code, 2);
});

test('hook: the deny message states the whitelist but does not name the off switch', () => {
  const home = makeHome('guard-msg-');
  const r = runHook({ home, guard: '1', input: bashInput('git push origin main') });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /after sourcing vars\.sh, with nothing but `cd`, `git add`, `git commit` and `git status` in the same command, and it never merges\./);
  assert.match(r.stderr, /follow the stop procedure/);
  assert.doesNotMatch(r.stderr, /CLAUDE_PIPELINE_GUARD/);
  assert.doesNotMatch(r.stderr, /guard\//);
});

test('hook: a command the guard cannot even tokenize fails closed when it mentions push or merge', () => {
  const home = makeHome('guard-deep-');
  const nest = '"$('.repeat(20000);
  const blocked = runHook({ home, guard: '1', input: bashInput(`${nest} git push origin main`) });
  assert.equal(blocked.code, 2);
  assert.ok(blocked.stderr.startsWith('claude-pipeline guard: could not check this command ('), blocked.stderr);
  const merge = runHook({ home, guard: '1', input: bashInput(`${nest} gh pr merge 5`) });
  assert.equal(merge.code, 2);
  const quiet = runHook({ home, guard: '1', input: bashInput(nest) });
  assert.equal(quiet.code, 0);
  assert.equal(quiet.stderr, '');
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
