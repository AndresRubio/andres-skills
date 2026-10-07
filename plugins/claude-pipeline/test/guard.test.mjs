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

test('denies approving or reviewing a pull request through gh, the reviews API and GraphQL (final review I5)', () => {
  for (const command of [
    'gh pr review 5 --approve',
    'gh pr review 5 --request-changes -b x',
    'cd x && gh pr review 5 --approve',
    'env gh pr review 5 --approve',
    'gh pr -R o/r review 5 --approve',
    'gh pr "review" 5 --approve',
  ]) assertDenied(command, /review/i);
  for (const command of [
    'gh api -X POST repos/o/r/pulls/5/reviews -f event=APPROVE',
    'gh api "repos/$REPO/pulls/5/reviews" -f event=REQUEST_CHANGES',
    'gh api -X POST repos/o/r/pulls/5/reviews/77/events -f event=APPROVE',
  ]) assertDenied(command, /review/i);
  for (const mutation of ['addPullRequestReview', 'submitPullRequestReview', 'approvePullRequest']) {
    assertDenied(`gh api graphql -f query='mutation { ${mutation}(input:{pullRequestId:"x", event:APPROVE}) { clientMutationId } }'`, /review/i);
  }
  assertAllowed('gh pr view 5');
  assertAllowed('gh pr view 5 --json reviews,comments');
  assertAllowed('gh api "repos/$REPO/pulls/5/comments"');
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
  // export GIT_CONFIG_COUNT=... is now caught by the git-env rule (round 4), a more specific reason
  assertDenied(`${s} && export GIT_CONFIG_COUNT=1 && git push origin claude/1-x`, /environment variables/);
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

// --- checkCommand: a subcommand the guard can't read, and eval (16a round 3) ---

test('denies a git or gh subcommand supplied by a variable or a glob', () => {
  for (const command of [
    'g=push; git $g origin main',
    'g=push; git $g origin claude/1-x:main',
    'g=git; p=push; $g $p origin main',
    'git "$g" origin main',
    'git ${g} origin main',
    'git $(echo push) origin main',
    'git pu* origin main',
    'git -C "$WT" $g origin main',
    'git -c a=b --git-dir x $g origin main',
    '$g $p origin main',
    'p=merge; gh pr $p 5',
    'gh $x merge 5',
    'gh pr -R o/r $p 5',
    'gh pr --repo o/r $p 5',
    'gh pr --repo=o/r $p 5',
    'gh "$x" 5',
    'gh pr $p',
    'GH pr $p 5',
    '$GH pr $p 5',
    '/usr/bin/gh p? 5',
    `${prefix(HOME)}git push origin "$BRANCH" && g=x; git $g origin main`,
  ]) {
    assertKind(command, 'forbidden');
    assertDenied(command, /hidden|push|git|gh/);
  }
  assertDenied('g=push; git $g origin main', /a git or gh subcommand hidden in a variable or glob/);
  assertDenied('gh pr -R o/r $p 5', /a git or gh subcommand hidden in a variable or glob/);
});

test('still allows git and gh commands whose subcommand is written out', () => {
  for (const command of [
    'git status',
    'git -C "$WT" status',
    'git -C "$WT" diff --name-only "$BASE_SHA"...HEAD',
    'git -c core.quotepath=off diff "$BASE_SHA"',
    'git log --oneline -5',
    'git diff "$BASE_SHA"...HEAD',
    'git add "$FILE" && git commit -F "$RUN_DIR/commit-msg.txt"',
    'git merge --ff-only "origin/$BRANCH"',
    'git status "$WT"',
    'gh pr view 5 --json mergeable',
    'gh pr view "$PR" --repo "$REPO" --json number,url',
    'gh pr list --repo "$REPO" --json number',
    'gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number,url',
    'gh pr -R "$REPO" view 5',
    'gh pr --repo "$REPO" list',
    'gh pr create --repo "$REPO" --title "$(cat "$RUN_DIR/pr-title.txt")" --body-file "$RUN_DIR/pr-body.md"',
    'gh pr comment "$PR" --repo "$REPO" --body-file "$RUN_DIR/fix-comment.md"',
    'gh api "repos/$REPO/issues/$NUMBER" --jq .id',
    'gh issue view "$NUMBER" --repo "$REPO" --json title',
    'node "$PIPELINE" config',
    '"$EDITOR" notes.md',
    '$EDITOR notes.md',
  ]) {
    assertAllowed(command);
  }
});

test('denies eval, however it is reached', () => {
  for (const command of [
    'eval "git status"',
    'eval x',
    'X=1 eval x',
    'true && eval "$cmd"',
    '{ eval x; }',
    'if true; then eval x; fi',
    'command eval x',
    'builtin eval x',
  ]) {
    assertKind(command, 'forbidden');
  }
  assertDenied('eval "git status"', /^eval$/);
  assertAllowed('git log --grep=eval');
  assertAllowed('echo eval');
  assertAllowed('grep -rn eval src');
  assertAllowed('ls evaluate.txt');
});

test('counts push and git after an equals sign as words', () => {
  assertKind('g=push; git status', 'forbidden');
  assertKind('g=git; p=push; echo $g $p', 'forbidden');
  assertKind('x=git y=push', 'forbidden');
  assertAllowed('g=x; git status');
  assertAllowed('a=pushes; git status');
  assertAllowed('a=git-hooks; echo push-docs');
  assertAllowed('git grep -n "--push=x" -- src');
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

// --- checkCommand: command-line config, GIT_* env, dequoted push, plumbing, gh repo (16a round 4) ---

test('denies git config given on the command line that controls pushes', () => {
  for (const command of [
    'git -c alias.p=pu"sh" p origin claude/1-x:main',
    'git -c include.path=/tmp/evil x origin main',
    'V=pu"sh"; git --config-env=alias.x=V x origin main',
    'git -c alias.x=push x origin main',
    "git -c 'alias.x=!git push origin main' x",
    'git -c "$k=push" x',
    "git -c alias.p=pu''sh p origin claude/1-x:main",
    'git --config-env alias.x=V x origin main',
    'git -c "core.hooksPath=/dev/null" push origin claude/1-x',
    'git -C "$WT" -c alias.x=push status',
    'git -c "alias.x=$V" x origin main',
    'git -c "credential.helper=!f" x',
    'git -c "protocol.ext.allow=always" x',
    'git -c uploadpack.allowAnySHA1InWant=true x',
    'git -c "core.gitProxy=evil" x',
    'git -c "url.https://evil/.insteadOf=https://github.com/" x',
  ]) {
    assertKind(command, 'forbidden');
  }
  assertDenied('git -c include.path=/tmp/evil x origin main', /command line/);
});

test('denies setting git environment variables', () => {
  for (const command of [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0=pu"sh" git x origin main',
    'export GIT_DIR=/tmp/x && git status',
    'env GIT_CONFIG_PARAMETERS="\'alias.x=push\'" git x',
    'GIT_DIR=x git status',
    'GIT_SSH_COMMAND=evil git status',
    'declare -x GIT_DIR=/tmp/x',
    'GIT_WORK_TREE=/tmp git status',
    `${source(HOME)} && export GIT_CONFIG_COUNT=1 && git push origin claude/1-x`,
  ]) {
    assertKind(command, 'forbidden');
  }
  assertDenied('export GIT_DIR=/tmp/x && git status', /environment variables/);
  assertAllowed('echo GIT_DIR');
  // round 5: any leading assignment on a git or gh segment is denied, whatever its name
  assertKind('GITHUB_TOKEN=x git status', 'forbidden');
});

test('denies git plumbing that pushes', () => {
  for (const command of [
    'git send-pack /tmp/o.git claude/1-x:main',
    'git-send-pack /tmp/o.git x',
    'git remote-ext x y',
    'git http-push /tmp/o.git',
    'git-http-push x',
    'git-remote-https origin url',
    'git remote-fd 3 4',
    '/usr/bin/git send-pack /tmp/o.git x',
    'git -C "$WT" send-pack /tmp/o.git x',
  ]) {
    assertKind(command, 'forbidden');
  }
  assertDenied('git send-pack /tmp/o.git claude/1-x:main', /plumbing/);
  assertAllowed('git remote -v');
  assertAllowed('git remote get-url origin');
  assertAllowed('git remote prune origin');
});

test('denies gh repo commands that rewrite branches or settings', () => {
  for (const command of [
    'gh repo sync o/r --branch main --force',
    'gh repo edit --default-branch x',
    'gh repo delete o/r --yes',
    'gh repo rename new-name',
    'gh repo archive o/r',
    'GH repo edit --default-branch x',
    '/usr/local/bin/gh repo sync o/r',
  ]) {
    assertKind(command, 'forbidden');
  }
  assertDenied('gh repo edit --default-branch x', /gh repo/);
  assertAllowed('gh repo view --json nameWithOwner -q .nameWithOwner');
  assertAllowed('gh repo view o/r --json defaultBranchRef');
  assertAllowed('gh repo clone o/r');
});

test('denies a push whose word is split by quotes or escapes (dequoted catch-all)', () => {
  for (const command of [
    "git submodule foreach 'git pu''sh origin main'",
    "'git' pu\\sh origin main",
    'git status && echo pu"sh"',
    "git status && echo pu''sh",
  ]) {
    assertKind(command, 'forbidden');
  }
  // the dequoted check does not deny a benign command that merely contains git and a split word
  assertAllowed('echo pu"sh" && ls');
  assertAllowed('git status');
});

// --- checkCommand: environment redirection, command-line config allowlist (16a round 5) ---

test('denies environment redirection on git and gh', () => {
  for (const command of [
    String.raw`mkdir -p /tmp/h && printf '[alias]\n\tsy = !git send-pack <origin> +HEAD:main\n' > /tmp/h/.gitconfig && HOME=/tmp/h git sy`,
    'XDG_CONFIG_HOME=/tmp/x git sy',
    'GH_CONFIG_DIR=/tmp/g gh x 5',
    'export HOME=/tmp/h && git sy',
    'env HOME=/tmp/h git sy',
    'PATH=/tmp/e:$PATH git status',
    'GH_REPO=o/other gh pr view 5',
    'declare -x XDG_CONFIG_DIRS=/tmp/x',
    'SSH_ASKPASS=/tmp/a true',
    'SSH_AUTH_SOCK=/tmp/s ls',
    'X=1 gh pr view 5',
    'LANG=C git log -1',
    'X=1 /usr/bin/git status',
  ]) {
    assertKind(command, 'forbidden');
  }
  assertDenied('LANG=C git log -1', /^environment assignments before git or gh$/);
  assertDenied('export HOME=/tmp/h && git sy', /^setting environment variables that redirect git or gh$/);
  // a harmless assignment on a segment that isn't git or gh stays allowed
  assertAllowed('GITHUB_TOKEN_NOTE=x true');
  assertAllowed('X=1 true && git status');
  assertAllowed('echo "$HOME"');
});

test('allows only a short list of keys in command-line git config', () => {
  for (const command of [
    "git -c core.pager='sh -c x' log",
    'git -c core.fsmonitor=/tmp/e status',
    'git -c sequence.editor=x rebase -i HEAD~1',
    'git -c diff.external=x diff',
    'git -c diff.x.textconv=x diff',
    'git -c core.editor=x commit',
    'git -c color.$x=never log',
    'git -c "user.name*=x" log',
    'git --config-env=core.pager=V log',
    'git -ccore.pager=x log',
  ]) {
    assertKind(command, 'forbidden');
    assertDenied(command, /^git config on the command line$/);
  }
  for (const command of [
    'git -c core.quotepath=off diff',
    'git -c color.ui=never log -1',
    'git -c Color.UI=never log -1',
    'git -c user.name=A -c user.email=a@b.c status',
    'git -c advice.detachedHead=false status',
    'git -c init.defaultBranch=main status',
    'git -C "$WT" -c core.quotepath=off diff',
  ]) {
    assertAllowed(command);
  }
});

// Every backticked span in the skill's markdown, as { file, span }.
function documentedSpans() {
  const skillDir = fileURLToPath(new URL('../skills/ship/', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'scripts') walk(full); } else if (name.endsWith('.md')) files.push(full);
    }
  };
  walk(skillDir);
  return files.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/`([^`\n]+)`/g)].map((m) => ({ file, span: m[1] })));
}

test('allows every push the skill documents, in the form the skill gives it', () => {
  const pushes = documentedSpans().filter(({ span }) => span.includes('git push'));
  for (const { span } of pushes) assertAllowed(`${prefix(HOME)}${span}`);
  assert.ok(pushes.length >= 10, `expected to find the documented pushes, found ${pushes.length}`);
});

test('allows every git and gh command the skill documents (placeholders filled in)', () => {
  const commands = documentedSpans()
    .map(({ span }) => span.replace(/<[^<>\s]*>/g, 'x'))
    .filter((span) => /^(git|gh) /.test(span) && !/^gh pr merge\b/.test(span));
  for (const span of commands) assertAllowed(span.includes('git push') ? `${prefix(HOME)}${span}` : span);
  assert.ok(commands.length >= 25, `expected to find the documented commands, found ${commands.length}`);
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

  // a subcommand hidden in a variable is forbidden, not something to reshape
  const hidden = runHook({ home, guard: '1', input: bashInput('g=push; git $g origin claude/1-x:main') });
  assert.equal(hidden.code, 2);
  assert.ok(hidden.stderr.startsWith('claude-pipeline guard: a git or gh subcommand hidden in a variable or glob.'), hidden.stderr);
  assert.match(hidden.stderr, /follow the stop procedure/);
  assert.doesNotMatch(hidden.stderr, /Split the command/);

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
