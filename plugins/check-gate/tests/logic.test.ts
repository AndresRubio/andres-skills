import { describe, expect, test } from 'claude-code/testing'

import { createParser, detectCommand, findCommit, shortLabel } from '../hooks/logic'

describe('findCommit', () => {
  test('finds plain and option-laden commits', async () => {
    expect(findCommit('git commit -m "x"')).toEqual({})
    expect(
      findCommit('git -c user.name=AndresRubio -c user.email=a@b.c commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"'),
    ).toEqual({})
    expect(findCommit('git -c user.name="Andres Rubio" commit -am wip')).toEqual({})
    expect(findCommit('git add -A && git commit --amend --no-edit')).toEqual({})
    expect(findCommit('/usr/bin/git --no-pager commit')).toEqual({})
  })

  test('reads the folder the commit runs in', async () => {
    expect(findCommit('git -C ../evals commit -m x')).toEqual({ dir: '../evals' })
    expect(findCommit('git -C "/a b/c" commit')).toEqual({ dir: '/a b/c' })
    expect(findCommit('cd evals && git add . && git commit -m x')).toEqual({ dir: 'evals' })
    expect(findCommit("cd '/x y' ; cd z && git commit")).toEqual({ dir: '/x y/z' })
  })

  test('follows the folder through the command', async () => {
    expect(findCommit('cd /a && cd b && git commit -m x')).toEqual({ dir: '/a/b' })
    expect(findCommit('cd /a && git -C b commit -m x')).toEqual({ dir: '/a/b' })
    expect(findCommit('git -C /a -C b commit -m x')).toEqual({ dir: '/a/b' })
    expect(findCommit('cd ~/a && cd b && git commit -m x')).toEqual({ dir: '~/a/b' })
    expect(findCommit('cd && git commit -m x')).toEqual({ dir: '~' })
    expect(findCommit('pushd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('cd /other || exit 1\ngit commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('cd /other; git add .; git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('git add . && cd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('cd /other >/dev/null 2>&1 && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('builtin cd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('S=/other && cd /a; git commit -m x')).toEqual({ dir: '/a' })
    expect(findCommit('env cd /other && git commit -m x')).toEqual({})
    expect(findCommit('git commit -m a && git commit --amend --no-edit')).toEqual({})
  })

  test('fills in variables the command sets', async () => {
    expect(findCommit('S=/other; cd $S && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('S=/other; cd "$S/sub" && git commit -m x')).toEqual({ dir: '/other/sub' })
    expect(findCommit('S=/a && T=$S/b && cd "${T}" && git commit -m x')).toEqual({ dir: '/a/b' })
    expect(findCommit('export S=/other; cd $S && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('S=/other; git -C $S commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('cd $HOME/a && git commit -m x')).toEqual({ dir: '~/a' })
    expect(findCommit('S="/a b"; cd "$S" && git commit -m x')).toEqual({ dir: '/a b' })
    expect(findCommit('S=/a; (S=/b); cd $S && git commit -m x')).toEqual({ dir: '/a' })
    expect(findCommit(`S=/a; bash -c "cd $S && git commit -m x"`)).toEqual({ dir: '/a' })
    expect(findCommit("cd '$S' && git commit -m x")).toEqual({ dir: '$S' })
  })

  test('reads a cd in a condition, a subshell or a nested shell', async () => {
    expect(findCommit('if cd /other; then git commit -m x; fi')).toEqual({ dir: '/other' })
    expect(findCommit('if true; then cd /other; git commit -m x; fi')).toEqual({ dir: '/other' })
    expect(findCommit('{ cd /other; git commit -m x; }')).toEqual({ dir: '/other' })
    expect(findCommit('(cd /other && git commit -m x)')).toEqual({ dir: '/other' })
    expect(findCommit('(cd /other && git status) && git commit -m x')).toEqual({})
    expect(findCommit('X=$(cd /other && pwd) && git commit -m x')).toEqual({})
    expect(findCommit('bash -c "cd /other && git commit -m x"')).toEqual({ dir: '/other' })
    expect(findCommit("sh -lc 'git add . ; git commit -m x'")).toEqual({})
    expect(findCommit('bash -c "cd /other" && git commit -m x')).toEqual({})
  })

  test('reads a nested shell through its flags', async () => {
    const shells = ['bash --norc -c', 'bash --noprofile --norc -c', 'bash -o pipefail -c', 'bash -eo pipefail -c', 'bash +x -c', 'bash --rcfile /x -c', 'bash -ce', 'bash -c -x', 'zsh -f -c']
    for (const shell of shells) expect(findCommit(`${shell} 'cd /other && git commit -m x'`)).toEqual({ dir: '/other' })
    expect(findCommit(`echo --norc -c 'cd /other && git commit -m x'`)).toEqual({})
  })

  test('is not fooled by text that only looks like a move', async () => {
    expect(findCommit('# cd /other\ngit commit -m x')).toEqual({})
    expect(findCommit('echo "; cd /other" && git commit -m x')).toEqual({})
    expect(findCommit("echo 'cd /other; x'; git commit -m x")).toEqual({})
    expect(findCommit("cat > f <<'EOF'\ncd /other\nEOF\ngit commit -m x")).toEqual({})
    expect(findCommit('git commit -F - <<EOF\nfix cd /other && git commit\nEOF')).toEqual({})
    expect(findCommit('git commit -m "cd /other; git commit"')).toEqual({})
    expect(findCommit('echo "run git commit later"')).toEqual({})
  })

  test('keeps reading a list past a newline after an operator', async () => {
    expect(findCommit('mkdir -p /a && cd /a &&\ngit commit -m x')).toEqual({ dir: '/a' })
    expect(findCommit('true && cd /a &&\n\n  git commit -m x')).toEqual({ dir: '/a' })
    expect(findCommit('true && cd /a && # why\ngit commit -m x')).toEqual({ dir: '/a' })
    expect(findCommit('cd /a &&\ngit commit -m x')).toEqual({ dir: '/a' })
    expect(findCommit('git add . &&\ngit commit -m x')).toEqual({})
    expect(findCommit('cd /a ||\nexit 1\ngit commit -m x')).toEqual({ dir: '/a' })
    // A heredoc's body still starts after that newline.
    expect(findCommit(`cat <<EOF &&\nit's\nEOF\ngit commit -m x`)).toEqual({})
    expect(findCommit(`true && cat <<EOF &&\nit's\nEOF\ncd /a &&\ngit commit -m x`)).toEqual({ dir: '/a' })
  })

  test('follows a commit inside a substitution in a string', async () => {
    expect(findCommit('X="$(cd /other && git commit -m x)"')).toEqual({ dir: '/other' })
    expect(findCommit('echo "$(cd /other && git commit -m x)"')).toEqual({ dir: '/other' })
    expect(findCommit('echo "`cd /other && git commit -m x`"')).toEqual({ dir: '/other' })
    expect(findCommit('echo "a $(echo b) $(cd /other && git commit -m x)"')).toEqual({ dir: '/other' })
    expect(findCommit('cd /a; echo "$(cd b; git commit -m x)"')).toEqual({ dir: '/a/b' })
    // The outer shell expands the substitution before the inner shell runs its cd.
    expect(findCommit('bash -c "cd /a; $(git commit -m x)"')).toEqual({})
    expect(findCommit('X="$(cd "$REPO" && git commit -m x)"')?.unplaced).toContain('cd $REPO')
    // A closed substitution keeps its cd to itself, and plain text in a string stays a mention.
    expect(findCommit('X="$(cd /other; pwd)"; git commit -m x')).toEqual({})
    expect(findCommit('cd "$REPO" && echo "$(pwd) run git commit later"')).toEqual({})
    expect(findCommit('cd "$REPO"; gh pr create --body "$(cat <<\'EOF\'\nrun git commit\nEOF\n)"')).toEqual({})
  })

  test('reads the quotes and heredocs inside a substitution', async () => {
    const heredocs = [
      `git commit -m "$(cat <<'EOF'\n1) see "a b"\nEOF\n)" && cd /other && git commit -m y`,
      `git commit -m "$(cat <<'EOF'\nfix (foo\nEOF\n)" && cd /other && git commit -m y`,
      `git commit -m "$(cat <<EOF\nit's\nEOF\n)" && cd /other && git commit -m y`,
      `git commit -m "$(echo ')')" && cd /other && git commit -m y`,
      `git commit -m "$(echo '(')" && cd /other && git commit -m y`,
      `git commit -m "$(echo "a")" && cd /other && git commit -m y`,
      `git commit -m "$(echo a # it's )\n)" && cd /other && git commit -m y`,
      'git commit -m "`echo "a"`" && cd /other && git commit -m y',
    ]
    for (const command of heredocs) expect(findCommit(command)?.unplaced).toContain('different folders')
    expect(findCommit(`echo "$(cat <<EOF\n)\nEOF\n)"; cd /other && git commit -m x`)).toEqual({ dir: '/other' })
  })

  test('is not fooled by arithmetic or an escape string', async () => {
    expect(findCommit('x=$((1<<2))\ncd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('x=$(( (1<<2) * 3 ))\ncd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('((x=1<<2))\ncd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('echo "$((1<<2)) it\'s"\ncd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('for ((i=0;i<<1;i++)); do cd /other; git commit -m x; done')).toEqual({ dir: '/other' })
    expect(findCommit("echo $'it\\'s'; cd /other && git commit -m x")).toEqual({ dir: '/other' })
    expect(findCommit("bash -c $'cd /other; git commit -m x'")).toEqual({ dir: '/other' })
    // Two subshells, not arithmetic.
    expect(findCommit('((cd /a); cd /other && git commit -m x)')).toEqual({ dir: '/other' })
    expect(findCommit("cd $'/a' && git commit -m x")?.unplaced).toContain('only the shell can work out')
    expect(findCommit('cd $((1)) && git commit -m x')?.unplaced).toContain('only the shell can work out')
  })

  test('takes a quoted ~ as a folder called ~', async () => {
    expect(findCommit('cd "~/a"; git commit -m x')).toEqual({ dir: './~/a' })
    expect(findCommit("cd '~' && git commit -m x")).toEqual({ dir: './~' })
    expect(findCommit('cd \\~/a && git commit -m x')).toEqual({ dir: './~/a' })
    expect(findCommit('S="~/a"; cd "$S"; git commit -m x')).toEqual({ dir: './~/a' })
    expect(findCommit('git -C "~/a" commit -m x')).toEqual({ dir: './~/a' })
    expect(findCommit('S=~/a; cd "$S"; git commit -m x')).toEqual({ dir: '~/a' })
  })

  test('reads home from HOME', async () => {
    expect(findCommit('HOME=/other; cd; git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('HOME=/other; cd ~/a; git commit -m x')).toEqual({ dir: '/other/a' })
    expect(findCommit('export HOME=/other; git -C ~ commit -m x')).toEqual({ dir: '/other' })
    // HOME is already exported, so a new value reaches an inner shell.
    expect(findCommit("HOME=/other; bash -c 'cd; git commit -m x'")).toEqual({ dir: '/other' })
    expect(findCommit('cd ~ && git commit -m x')).toEqual({ dir: '~' })
  })

  test('sees a commit inside a function, and moves it could not see', async () => {
    expect(findCommit('f() { echo; }; git commit -m x')).toEqual({})
    // Empty parentheses that define nothing.
    expect(findCommit('x=(); if true; then git commit -m x; fi')).toEqual({})
    expect(findCommit('echo $(); { git commit -m x; }')).toEqual({})
    expect(findCommit('time -p git commit -m x')).toEqual({})
    expect(findCommit('env X=1 git commit -m x')).toEqual({})
    expect(findCommit('CDPATH= cd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('f() { echo "run git commit later"; }')).toEqual({})
  })

  test('never refuses a commit that may only be a mention', async () => {
    expect(findCommit('cd "$REPO" && echo "run git commit later"')).toEqual({})
    expect(findCommit('GIT_DIR=/x echo "run git commit later"')).toEqual({})
    expect(findCommit('cd "$REPO"; cat > f <<EOF\nrun git commit later\nEOF')).toEqual({})
    expect(findCommit('git commit -m x; cd /b; echo "run git commit later"')).toEqual({})
    expect(findCommit('cd /b; echo "run git commit later"')).toEqual({ dir: '/b' })
  })

  test('refuses a commit it cannot place, and says why', async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['GIT_DIR=/other/.git git commit -m x', 'GIT_DIR'],
      ['env GIT_WORK_TREE=/other git commit -m x', 'GIT_WORK_TREE'],
      ['export GIT_DIR=/other/.git; git commit -m x', 'GIT_DIR'],
      ['git --git-dir=/other/.git --work-tree=/other commit -m x', '--git-dir'],
      ['git --git-dir /other/.git commit -m x', '--git-dir'],
      ['git --work-tree /other commit -m x', '--work-tree'],
      ['cd "$REPO" && git commit -m x', 'cd $REPO'],
      ['S=$(mktemp -d); cd $S && git commit -m x', 'cd $S'],
      ['S=/a; unset S; cd $S && git commit -m x', 'cd $S'],
      ['local S=/a; cd $S && git commit -m x', 'cd $S'],
      ['S=/a; local S=/b; cd $S && git commit -m x', 'cd $S'],
      ['local GIT_DIR=/other/.git; git commit -m x', 'GIT_DIR'],
      ['S=/a; S+=/b; cd $S && git commit -m x', 'cd $S'],
      ['(S=/a); cd $S && git commit -m x', 'cd $S'],
      ['S=/a cd $S && git commit -m x', 'cd $S'],
      ['S=/a & cd $S && git commit -m x', 'cd $S'],
      ['true && S=/a; cd $S && git commit -m x', 'cd $S'],
      ['if true; then S=/a; fi; cd $S && git commit -m x', 'cd $S'],
      ['S=/a; for S in /b; do cd $S; git commit -m x; done', 'cd $S'],
      ['S="/a b"; cd $S && git commit -m x', 'cd $S'],
      ['S=/a; bash -c \'cd $S && git commit -m x\'', 'cd $S'],
      ['cd $(git rev-parse --show-toplevel) && git commit -m x', 'only the shell can work out'],
      ['cd /a/* && git commit -m x', 'only the shell can work out'],
      ['cd ~other/a && git commit -m x', 'only the shell can work out'],
      ['cd -P /a && git commit -m x', 'only the shell can work out'],
      ['cd /a /b && git commit -m x', 'only the shell can work out'],
      ['git -C "$REPO" commit -m x', 'git -C $REPO'],
      ['cd - && git commit -m x', 'cd -'],
      ['cd /a && cd - && git commit -m x', 'cd -'],
      ['popd && git commit -m x', 'popd'],
      ['pushd /a && popd && git commit -m x', 'popd'],
      ['pushd && git commit -m x', 'pushd'],
      ['[ -d a ] && cd a; git commit -m x', 'may not run'],
      ['true || cd a; git commit -m x', 'may not run'],
      ['cd /a || cd /b; git commit -m x', 'may not run'],
      ['cat f | cd /a; git commit -m x', 'may not run'],
      ['cd /a && cd b; git commit -m x', 'may not run'],
      ['cd /missing && cd /other\ngit commit -m x', 'may not run'],
      ['if true; then cd /a; fi; git commit -m x', 'ended before the commit'],
      ['if true; then cd /a; else git commit -m x; fi', 'ended before the commit'],
      ['for d in a; do cd /a; done; git commit -m x', 'ended before the commit'],
      ['case x in x) cd /a;; esac; git commit -m x', 'ended before the commit'],
      ['cd /a | cat; git commit -m x', 'pipeline or the background'],
      ['cd /a & git commit -m x', 'pipeline or the background'],
      ['cd /a && true & git commit -m x', 'pipeline or the background'],
      ['{ cd /a; } | cat; git commit -m x', 'ended before the commit'],
      ['function f { cd /a; }; f; git commit -m x', 'ended before the commit'],
      ['eval "cd /a"; git commit -m x', 'eval'],
      ['eval "cd /a && git commit -m x"', 'eval'],
      ['command cd /a && git commit -m x', 'command cd'],
      ['f() { git commit -m x; }; cd /a; f', 'function'],
      ['function f { git commit -m x; }; cd /a; f', 'function'],
      ['f() {\n  git commit -m x\n}\ncd /a\nf', 'function'],
      ['false &&\ncd /a; git commit -m x', 'may not run'],
      ['true ||\ncd /a; git commit -m x', 'may not run'],
      ['true |\ncd /a; git commit -m x', 'may not run'],
      ['true && # why\ncd /a; git commit -m x', 'may not run'],
      ['chdir /a; git commit -m x', 'chdir'],
      ['chdir /a && git commit -m x', 'chdir'],
      ['time -p cd /a; git commit -m x', 'time -p'],
      ['time -p cd /a && git commit -m x', 'time -p'],
      ['env -C /a git commit -m x', 'env -C'],
      ['env --chdir=/a git commit -m x', 'env -C'],
      ['CDPATH=/x; cd a; git commit -m x', 'CDPATH'],
      ['CDPATH=/x cd a && git commit -m x', 'CDPATH'],
      ['export CDPATH=/x; cd a && git commit -m x', 'CDPATH'],
      ['S=/a; printf -v S %s /b; cd "$S" && git commit -m x', 'cd $S'],
      ['S=/a; getopts o S; cd "$S" && git commit -m x', 'cd $S'],
      ['unset HOME; cd; git commit -m x', 'only the shell can work out'],
      ['unset HOME; cd ~/a; git commit -m x', 'only the shell can work out'],
      ['true && HOME=/a; cd; git commit -m x', 'only the shell can work out'],
      ['HOME=/other cd; git commit -m x', 'only the shell can work out'],
      ['cd /a && git commit -m x; cd /b && git commit -m y', 'different folders'],
    ]
    for (const [command, reason] of cases) {
      const found = findCommit(command)
      expect(found).toBeDefined()
      expect(found?.dir).toBeUndefined()
      expect(found?.unplaced).toContain(reason)
    }
  })

  test('stays fast on text it could read many ways', async () => {
    const commands = [
      'git -c ' + '\\\\'.repeat(18) + ' x',
      'git -c ' + 'a\\b'.repeat(24) + ' x',
      'git ' + '-c '.repeat(32) + 'status',
      'git ' + '-C '.repeat(32) + 'status',
      'git ' + '--git-dir '.repeat(32) + 'status',
      'git ' + '--namespace '.repeat(32) + 'status',
      'git ' + '-c --work-tree '.repeat(16) + 'status',
    ]
    for (const command of commands) {
      const started = Date.now()
      expect(findCommit(command)).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(200)
    }
  })

  test('still reads what those options and words mean', async () => {
    expect(findCommit('git -c a=' + '\\\\'.repeat(500) + ' commit -m x')).toEqual({})
    expect(findCommit('git -c a\\ b=c commit -m x')).toEqual({})
    expect(findCommit('git -C /a\\ b commit -m x')).toEqual({ dir: '/a b' })
    expect(findCommit('git --no-pager -c a=b -C /other commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('git --namespace=x commit -m x')).toEqual({})
    expect(findCommit('git --namespace x commit -m x')).toEqual({})
    expect(findCommit('git -C commit commit -m x')).toEqual({ dir: 'commit' })
    // The word after -C or -c is its value, so there's no commit here.
    expect(findCommit('git -C commit')).toBeUndefined()
    expect(findCommit('git -c commit')).toBeUndefined()
    expect(findCommit('git --namespace commit')).toBeUndefined()
  })

  test('takes a commit setting on the command line for a commit', async () => {
    // The real subcommand can be out of sight, as these from real sessions show.
    expect(findCommit('git -c user.name=t -c commit.gpgsign=false "$@"')).toEqual({})
    expect(findCommit("git -c commit.gpgsign=false rebase -q --root --exec 'git -c commit.gpgsign=false commit --amend'")).toEqual({})
    expect(findCommit('git -C /other -c commit.gpgsign=false "$@"')).toEqual({ dir: '/other' })
    // The folder still comes from every option when the subcommand is in sight.
    expect(findCommit('git -c commit.gpgsign=false -C /other commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('git -c commit.gpgsign=false --dry-run')).toBeUndefined()
    // A value that merely starts with the word isn't one.
    expect(findCommit('git -c committer.name=x status')).toBeUndefined()
    expect(findCommit('git -c a=commit.b status')).toBeUndefined()
  })

  test('ignores what is not a commit', async () => {
    expect(findCommit('git status')).toBeUndefined()
    expect(findCommit('git log --grep commit')).toBeUndefined()
    expect(findCommit('git commit-tree HEAD^{tree}')).toBeUndefined()
    expect(findCommit('git commit --dry-run')).toBeUndefined()
    expect(findCommit('legit commit')).toBeUndefined()
    expect(findCommit('echo abcd commit')).toBeUndefined()
  })
})

describe('detectCommand', () => {
  test('prefers scripts/check.sh', async () => {
    expect(detectCommand({ hasCheckScript: true, packageJson: '{"scripts":{"check":"x"}}', lockfiles: [] })).toBe(
      'bash scripts/check.sh',
    )
  })

  test('runs package.json check with the lockfile manager', async () => {
    const packageJson = '{"scripts":{"check":"npm run typecheck && npm test"}}'
    expect(detectCommand({ hasCheckScript: false, packageJson, lockfiles: [] })).toBe('npm run check')
    expect(detectCommand({ hasCheckScript: false, packageJson, lockfiles: ['pnpm-lock.yaml'] })).toBe('pnpm run check')
    expect(detectCommand({ hasCheckScript: false, packageJson, lockfiles: ['yarn.lock'] })).toBe('yarn run check')
  })

  test('finds nothing without a check', async () => {
    expect(detectCommand({ hasCheckScript: false, lockfiles: [] })).toBeUndefined()
    expect(detectCommand({ hasCheckScript: false, packageJson: '{"scripts":{"test":"x"}}', lockfiles: [] })).toBeUndefined()
    expect(detectCommand({ hasCheckScript: false, packageJson: 'not json', lockfiles: [] })).toBeUndefined()
  })
})

test('shortLabel keeps the tool and the python version', async () => {
  expect(shortLabel('uv run ruff check .')).toBe('ruff')
  expect(shortLabel('uv run mypy src/axial scripts')).toBe('mypy')
  expect(shortLabel('env UV_PROJECT_ENVIRONMENT=.venv-3.13 uv run --python 3.13 pytest -q')).toBe('pytest 3.13')
  expect(shortLabel('uv run python scripts/knowledge_index.py --check')).toBe('knowledge_index')
  expect(shortLabel('typecheck')).toBe('typecheck')
})

const EVALS_FAILING = [
  '==> uv run ruff check .',
  'All checks passed!',
  '==> uv run mypy src/axial scripts',
  'Success: no issues found in 40 source files',
  '==> uv run pytest -q',
  'FAILED tests/test_x.py::test_y - assert 1 == 2',
  '==> env UV_PROJECT_ENVIRONMENT=.venv-3.13 uv run --python 3.13 pytest -q',
  'FAILED tests/test_x.py::test_y - assert 1 == 2',
  '==> uv run python scripts/knowledge_index.py --check',
  '==> failed:',
  '    uv run pytest -q',
  '    env UV_PROJECT_ENVIRONMENT=.venv-3.13 uv run --python 3.13 pytest -q',
  '',
].join('\n')

describe('createParser', () => {
  test('marks the steps the failed list names', async () => {
    const parser = createParser()
    parser.push(EVALS_FAILING)
    parser.finish()
    expect(parser.steps(1).map(step => `${step.label}:${step.status}`)).toEqual([
      'ruff:ok',
      'mypy:ok',
      'pytest:failed',
      'pytest 3.13:failed',
      'knowledge_index:ok',
    ])
    expect(parser.tail()).toContain('==> failed:')
  })

  test('follows steps while the output streams, split anywhere', async () => {
    const parser = createParser()
    expect(parser.push('==> uv run ruff ch')).toBe(false)
    expect(parser.push('eck .\nok\n==> uv run my')).toBe(true)
    expect(parser.steps().map(step => step.status)).toEqual(['running'])
    expect(parser.push('py src\n')).toBe(true)
    expect(parser.steps().map(step => `${step.label}:${step.status}`)).toEqual(['ruff:done', 'mypy:running'])
  })

  test('blames the last npm step when the run stops early', async () => {
    const parser = createParser('check')
    parser.push(
      [
        '',
        '> old-battle@0.0.0 check',
        '> npm run typecheck && npm test',
        '',
        '',
        '> old-battle@0.0.0 typecheck',
        '> echo typing',
        '',
        'typing',
        '',
        '> old-battle@0.0.0 test',
        '> vitest',
        '',
        'FAIL src/rules.test.ts',
      ].join('\n'),
    )
    parser.finish()
    expect(parser.steps(1).map(step => `${step.label}:${step.status}`)).toEqual(['typecheck:ok', 'test:failed'])
  })

  test('reads npm banners of a package with no version', async () => {
    const parser = createParser('check')
    parser.push(['', '> check', '> npm run lint', '', '', '> lint', '> eslint', '', 'clean', ''].join('\n'))
    expect(parser.steps(0).map(step => `${step.label}:${step.status}`)).toEqual(['lint:ok'])
  })

  test('strips colors and carriage-return redraws', async () => {
    const parser = createParser()
    parser.push('\x1b[1m==> uv run pytest -q\x1b[0m\nprogress 10%\rprogress 100%\n')
    parser.finish()
    expect(parser.steps(0)[0]?.label).toBe('pytest')
    expect(parser.tail()).toBe('==> uv run pytest -q\nprogress 100%')
  })

  test('a check with no step lines has no steps', async () => {
    const parser = createParser()
    parser.push('All checks passed!\n3 passed\n')
    parser.finish()
    expect(parser.steps(0)).toHaveLength(0)
  })
})
