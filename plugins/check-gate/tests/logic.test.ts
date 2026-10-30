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
    expect(findCommit("cd '/x y' ; cd z && git commit")).toEqual({ dir: 'z' })
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
