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

  test('reads a commit split by a line continuation', async () => {
    expect(findCommit('git \\\n  commit -m x')).toEqual({})
    expect(findCommit('git\\\n  commit -m x')).toEqual({})
    expect(findCommit('git -c a=b \\\n  -c c=d \\\n  commit -m x')).toEqual({})
    expect(findCommit('gi\\\nt com\\\nmit -m x')).toEqual({})
    expect(findCommit('git --no-\\\npager commit -m x')).toEqual({})
    expect(findCommit('git -C /other \\\n  commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('git -C \\\n  /other commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('git -C /oth\\\ner commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('cd /other \\\n  && git \\\n  commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit('c\\\nd /other && git commit -m x')).toEqual({ dir: '/other' })
    expect(findCommit("bash -c 'git add . ; git \\\n  commit -m x'")).toEqual({})
    expect(findCommit('bash -c "git add . ; git \\\n  commit -m x"')).toEqual({})
    expect(findCommit('git --work-\\\ntree=/other commit -m x')?.unplaced).toContain('--work-tree')
  })

  test('a line continuation joins only what the shell joins', async () => {
    // The shell reads these as `gitcommit`, `git commit-tree` and a dry run.
    expect(findCommit('git\\\ncommit -m x')).toBeUndefined()
    expect(findCommit('git commit-\\\ntree abc')).toBeUndefined()
    expect(findCommit('git commit \\\n  --dry-run')).toBeUndefined()
    // An escaped backslash ends the line, so the next line is its own command.
    expect(findCommit('echo a\\\\\ngit commit -m x')).toEqual({})
    expect(findCommit('echo a\\\\\ncd /other && git commit -m x')).toEqual({ dir: '/other' })
    // A comment ends at the newline whatever comes before it, so the next line runs.
    expect(findCommit('# note \\\ngit commit -m x')).toEqual({})
    expect(findCommit('true # note \\\ncd /other && git commit -m x')).toEqual({ dir: '/other' })
    // The line after a backslash in a heredoc body can still be the closing tag.
    expect(findCommit("cat > f <<'EOF'\nnote \\\nEOF\ncd /other && git commit -m x")).toEqual({ dir: '/other' })
    // A backslash before anything but a newline stays.
    expect(findCommit('cd /a\\ b && git commit -m x')).toEqual({ dir: '/a b' })
    expect(findCommit('git \\ commit -m x')).toBeUndefined()
  })

  test('refuses a commit behind an operator a line continuation splits', async () => {
    // bash joins these and zsh doesn't, so the two shells can land in different folders.
    const commands = [
      'cd /a &\\\n>/dev/null\ngit commit -m x',
      'cd /a &\\\n& git commit -m x',
      'false &\\\n& cd /a\ngit commit -m x',
      'cd /a 2\\\n>/dev/null; git commit -m x',
      'cd /a 2>\\\n&1; git commit -m x',
      'cd /a &\\\n\\\n& git commit -m x',
    ]
    for (const command of commands) {
      expect(findCommit(command)?.unplaced).toContain('bash and zsh read differently')
    }
    // These split nothing.
    expect(findCommit('cd /a && \\\n  git commit -m x')).toEqual({ dir: '/a' })
    expect(findCommit('cd /a >\\\n/dev/null && git commit -m x')).toEqual({ dir: '/a' })
    expect(findCommit('cd /a 2>/dev/null \\\n  && git commit -m x')).toEqual({ dir: '/a' })
    // A mention is never refused.
    expect(findCommit('echo "a &\\\n& run git commit later"')).toEqual({})
  })

  test('a line continuation in a message stays part of the message', async () => {
    expect(findCommit('git commit -m "one \\\n  two"')).toEqual({})
    expect(findCommit("git commit -m 'one \\\n  two'")).toEqual({})
    // Joined, a mention is still a mention: it never gets the commit refused.
    expect(findCommit("git commit -m 'run git \\\n  commit later'")).toEqual({})
    expect(findCommit('cd "$REPO" && echo "run git \\\n  commit later"')).toEqual({})
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

  test('is not fooled by text that only looks like a move', async () => {
    expect(findCommit('# cd /other\ngit commit -m x')).toEqual({})
    expect(findCommit('echo "; cd /other" && git commit -m x')).toEqual({})
    expect(findCommit("echo 'cd /other; x'; git commit -m x")).toEqual({})
    expect(findCommit("cat > f <<'EOF'\ncd /other\nEOF\ngit commit -m x")).toEqual({})
    expect(findCommit('git commit -F - <<EOF\nfix cd /other && git commit\nEOF')).toEqual({})
    expect(findCommit('git commit -m "cd /other; git commit"')).toEqual({})
    expect(findCommit('echo "run git commit later"')).toEqual({})
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
      ['cd /a && git commit -m x; cd /b && git commit -m y', 'different folders'],
    ]
    for (const [command, reason] of cases) {
      const found = findCommit(command)
      expect(found).toBeDefined()
      expect(found?.dir).toBeUndefined()
      expect(found?.unplaced).toContain(reason)
    }
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
