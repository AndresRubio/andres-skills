import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_LINES,
  absolutePath,
  couldBeProtected,
  describeLoad,
  dumpTargets,
  findLoads,
  globHitsProtected,
  isIsoDay,
  kindOfRel,
  limitProblem,
  loadReason,
  mayDump,
  mayLoad,
  monthsBetween,
  normalize,
  parseSteps,
  relativeTo,
} from '../hooks/logic'

const ROOT = '/Users/me/projects/boe-agent'
const HOME = '/Users/me'
// The session starts at the repo root, or one folder above it.
const IN_REPO = { cwd: ROOT, home: HOME }
const ABOVE = { cwd: '/Users/me/projects', home: HOME }

// The protected files a command dumps, as `kind:path under the root`.
function dumped(command: string, ctx = IN_REPO, planFiles: string[] = []): string[] {
  const hits: string[] = []
  for (const path of dumpTargets(command, ctx)) {
    const rel = relativeTo(ROOT, path)
    if (rel === undefined) continue
    if (/[*?[{]/.test(rel)) {
      if (globHitsProtected(rel, planFiles)) hits.push(`glob:${rel}`)
      continue
    }
    const kind = kindOfRel(rel)
    if (kind !== undefined) hits.push(`${kind}:${rel}`)
  }
  return hits
}

const PLAN = 'docs/superpowers/plans/2026-10-03-demo-web.md'

describe('kindOfRel', () => {
  test('names the two protected places, whatever the case or spelling', async () => {
    expect(kindOfRel('PROGRESS.md')).toBe('progress')
    expect(kindOfRel('progress.md')).toBe('progress')
    expect(kindOfRel('./PROGRESS.md')).toBe('progress')
    expect(kindOfRel('docs/superpowers/plans/../plans/x.md')).toBe('plans')
    expect(kindOfRel(PLAN)).toBe('plans')
    expect(kindOfRel('docs/superpowers/plans/sub/dir/x.md')).toBe('plans')
    expect(kindOfRel('Docs/Superpowers/Plans/X.md')).toBe('plans')
  })

  test('leaves every other file alone', async () => {
    expect(kindOfRel('AGENTS.md')).toBeUndefined()
    expect(kindOfRel('README.md')).toBeUndefined()
    expect(kindOfRel('docs/superpowers/specs/estado-actual.md')).toBeUndefined()
    expect(kindOfRel('docs/superpowers/specs/carga-de-meses.md')).toBeUndefined()
    expect(kindOfRel('docs/superpowers/plans-notes/x.md')).toBeUndefined()
    expect(kindOfRel('docs/superpowers/notas-citadas/README.md')).toBeUndefined()
    expect(kindOfRel('despliegue/PROGRESS.md.bak')).toBeUndefined()
    expect(kindOfRel('src/boe_agent/comandos/barrido.py')).toBeUndefined()
  })
})

describe('couldBeProtected', () => {
  test('is the cheap test before any git call', async () => {
    expect(couldBeProtected(`${ROOT}/PROGRESS.md`)).toBe(true)
    expect(couldBeProtected(`${ROOT}/progress.md`)).toBe(true)
    expect(couldBeProtected(`${ROOT}/${PLAN}`)).toBe(true)
    expect(couldBeProtected(`${ROOT}/docs/superpowers/plans`)).toBe(true)
    expect(couldBeProtected(`${ROOT}/docs/*/*.md`)).toBe(true)
    expect(couldBeProtected(`${ROOT}/AGENTS.md`)).toBe(false)
    expect(couldBeProtected(`${ROOT}/docs/superpowers/plans-notes/x.md`)).toBe(false)
    expect(couldBeProtected(`${ROOT}/tests/PROGRESS.md.bak`)).toBe(false)
  })
})

describe('the text looks that skip the parser', () => {
  test('never skip a command the parser would act on', async () => {
    for (const command of ['cat PROGRESS.md', 'less x', '/bin/cat PROGRESS.md', 'bash -c "more PROGRESS.md"', 'env x=1 bat PROGRESS.md', 'nl PROGRESS.md']) {
      expect(mayDump(command)).toBe(true)
    }
    for (const command of ['ls -la', 'git status', 'uv run pytest', 'grep -n x PROGRESS.md']) expect(mayDump(command)).toBe(false)
    expect(mayLoad(`${'uv run python -m boe_agent.comandos'}.barrido 2025-01-01 2025-01-31`)).toBe(true)
    expect(mayLoad("python -c 'import boe_agent.comandos.cola'")).toBe(true)
    expect(mayLoad('uv run pytest -m red')).toBe(false)
  })
})

describe('limitProblem', () => {
  test('a limit of one section passes', async () => {
    expect(limitProblem(1)).toBeUndefined()
    expect(limitProblem(200)).toBeUndefined()
    expect(limitProblem(MAX_LINES)).toBeUndefined()
    expect(limitProblem('120')).toBeUndefined()
  })

  test('no limit, or one that is no limit, is refused', async () => {
    expect(limitProblem(undefined)).toBe('missing')
    expect(limitProblem(null)).toBe('missing')
    expect(limitProblem(0)).toBe('missing')
    expect(limitProblem(-5)).toBe('missing')
    expect(limitProblem(2.5)).toBe('missing')
    expect(limitProblem(Number.NaN)).toBe('missing')
    expect(limitProblem('lots')).toBe('missing')
    expect(limitProblem({})).toBe('missing')
    expect(limitProblem(MAX_LINES + 1)).toBe('too-large')
    expect(limitProblem(2000)).toBe('too-large')
    expect(limitProblem(Number.POSITIVE_INFINITY)).toBe('missing')
  })
})

describe('paths', () => {
  test('normalizes and resolves', async () => {
    expect(normalize('/a/b/../c/./d//e')).toBe('/a/c/d/e')
    expect(normalize('/../x')).toBe('/x')
    expect(absolutePath('PROGRESS.md', IN_REPO)).toBe(`${ROOT}/PROGRESS.md`)
    expect(absolutePath('../x/y', IN_REPO)).toBe('/Users/me/projects/x/y')
    expect(absolutePath('~/a', IN_REPO)).toBe('/Users/me/a')
    expect(absolutePath('/etc/hosts', IN_REPO)).toBe('/etc/hosts')
    expect(relativeTo(ROOT, `${ROOT}/docs/x.md`)).toBe('docs/x.md')
    expect(relativeTo(ROOT, `${ROOT}-copy/x.md`)).toBeUndefined()
  })
})

describe('dumpTargets: commands that print a protected file whole', () => {
  test('cat, less and more of PROGRESS.md', async () => {
    expect(dumped('cat PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat ./PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat "PROGRESS.md"')).toEqual(['progress:PROGRESS.md'])
    expect(dumped("cat 'PROGRESS.md'")).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat -n PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('less PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('less -N +G PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('more PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('bat PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('tac PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat progress.md')).toEqual(['progress:progress.md'])
    expect(dumped('cat < PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat <PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped(`cat ${ROOT}/PROGRESS.md`)).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat ~/projects/boe-agent/PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
  })

  test('the plans folder', async () => {
    expect(dumped(`cat ${PLAN}`)).toEqual([`plans:${PLAN}`])
    expect(dumped(`less ${PLAN}`)).toEqual([`plans:${PLAN}`])
    expect(dumped('cat docs/superpowers/plans/../plans/2026-10-28-trazas-phoenix.md')).toEqual([
      'plans:docs/superpowers/plans/2026-10-28-trazas-phoenix.md',
    ])
    expect(dumped(`cat -n ${PLAN} AGENTS.md`)).toEqual([`plans:${PLAN}`])
  })

  test('from the folder above the repo, and through cd', async () => {
    expect(dumped('cat boe-agent/PROGRESS.md', ABOVE)).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cd boe-agent && cat PROGRESS.md', ABOVE)).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cd boe-agent; less PROGRESS.md', ABOVE)).toEqual(['progress:PROGRESS.md'])
    expect(dumped(`cd ${ROOT} && cat PROGRESS.md`, ABOVE)).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cd ~/projects/boe-agent && cat PROGRESS.md', ABOVE)).toEqual(['progress:PROGRESS.md'])
    expect(dumped('(cd boe-agent && cat PROGRESS.md)', ABOVE)).toEqual(['progress:PROGRESS.md'])
    expect(dumped(`cd docs/superpowers/plans && cat ${PLAN.split('/').pop()}`)).toEqual([`plans:${PLAN}`])
    expect(dumped('cd .. && cd boe-agent && cat PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
  })

  test('chains, wrappers and nested shells', async () => {
    expect(dumped('cat PROGRESS.md; echo done')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('echo start && cat PROGRESS.md && echo end')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('git status || cat PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat PROGRESS.md > /tmp/copy.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat PROGRESS.md 2>&1')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('PAGER=cat less PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('env LC_ALL=C cat PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('time cat PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('bash -c "cat PROGRESS.md"')).toEqual(['progress:PROGRESS.md'])
    expect(dumped("sh -c 'cd docs && cat ../PROGRESS.md'")).toEqual(['progress:PROGRESS.md'])
    expect(dumped('zsh -ic "cat PROGRESS.md"')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('echo $(cat PROGRESS.md)')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('echo `cat PROGRESS.md`')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('if cat PROGRESS.md; then echo ok; fi')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat PROGRESS.md | tee /tmp/x')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat PROGRESS.md\nls')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('for f in a b; do cat PROGRESS.md; done')).toEqual(['progress:PROGRESS.md'])
  })

  test('globs that would expand to a protected file', async () => {
    const names = ['2026-10-03-demo-web.md', '2026-10-28-trazas-phoenix.md']
    expect(dumped('cat docs/superpowers/plans/*.md', IN_REPO, names)).toEqual(['glob:docs/superpowers/plans/*.md'])
    expect(dumped('cat docs/superpowers/plans/*', IN_REPO, names)).toEqual(['glob:docs/superpowers/plans/*'])
    expect(dumped('cat docs/superpowers/plans/2026-10-0*', IN_REPO, names)).toEqual([
      'glob:docs/superpowers/plans/2026-10-0*',
    ])
    expect(dumped('cat docs/superpowers/*/*.md', IN_REPO, names)).toEqual(['glob:docs/superpowers/*/*.md'])
    expect(dumped('cat docs/superpowers/plans/{a,2026-10-03-demo-web}.md', IN_REPO, names)).toEqual([
      'glob:docs/superpowers/plans/{a,2026-10-03-demo-web}.md',
    ])
    expect(dumped('cat PROG*.md')).toEqual(['glob:PROG*.md'])
    expect(dumped('cat *.md')).toEqual(['glob:*.md'])
    expect(dumped('cat **/*.md')).toEqual(['glob:**/*.md'])
  })
})

describe('dumpTargets: near misses that must pass', () => {
  test('a pipe into head, sed or grep narrows the output', async () => {
    expect(dumped('cat PROGRESS.md | head -50')).toEqual([])
    expect(dumped('cat PROGRESS.md | head -n 50')).toEqual([])
    expect(dumped("cat PROGRESS.md | sed -n '100,200p'")).toEqual([])
    expect(dumped("cat PROGRESS.md | grep -n '^## '")).toEqual([])
    expect(dumped('cat PROGRESS.md | rg 76')).toEqual([])
    expect(dumped('cat PROGRESS.md | tee /tmp/x | head -5')).toEqual([])
    expect(dumped(`cat ${PLAN} | head -40`)).toEqual([])
    expect(dumped('cat PROGRESS.md|head -3')).toEqual([])
    expect(dumped('cat PROGRESS.md | wc -l')).toEqual([])
  })

  test('the pipe belongs to its own command, not the next one', async () => {
    expect(dumped('cat PROGRESS.md; ls | head')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('cat PROGRESS.md && grep -n x AGENTS.md')).toEqual(['progress:PROGRESS.md'])
    expect(dumped('grep x AGENTS.md | cat PROGRESS.md')).toEqual(['progress:PROGRESS.md'])
  })

  test('other readers of the same files', async () => {
    expect(dumped("grep -n '^## ' PROGRESS.md")).toEqual([])
    expect(dumped("sed -n '100,200p' PROGRESS.md")).toEqual([])
    expect(dumped('head -n 80 PROGRESS.md')).toEqual([])
    expect(dumped('tail -n 40 PROGRESS.md')).toEqual([])
    expect(dumped('wc -l PROGRESS.md')).toEqual([])
    expect(dumped('ls -la PROGRESS.md docs/superpowers/plans')).toEqual([])
    expect(dumped('git diff PROGRESS.md')).toEqual([])
    expect(dumped('git log --oneline -- PROGRESS.md')).toEqual([])
    expect(dumped('git show HEAD:PROGRESS.md')).toEqual([])
    expect(dumped('rg -n "O-2" PROGRESS.md docs/superpowers/plans')).toEqual([])
    expect(dumped('awk "NR<20" PROGRESS.md')).toEqual([])
  })

  test('other files, with the same readers', async () => {
    expect(dumped('cat AGENTS.md')).toEqual([])
    expect(dumped('cat README.md CLAUDE.md')).toEqual([])
    expect(dumped('cat docs/superpowers/specs/estado-actual.md')).toEqual([])
    expect(dumped('cat docs/superpowers/specs/carga-de-meses.md')).toEqual([])
    expect(dumped('less docs/superpowers/specs/pendientes.md')).toEqual([])
    expect(dumped('cat docs/superpowers/plans-notes/x.md')).toEqual([])
    expect(dumped('cat src/boe_agent/comandos/barrido.py')).toEqual([])
    expect(dumped('cat pyproject.toml | head')).toEqual([])
    expect(dumped('cat tests/PROGRESS.md.bak')).toEqual([])
    expect(dumped('cat other/PROGRESS.md.txt')).toEqual([])
    expect(dumped('cat')).toEqual([])
    expect(dumped('cat -')).toEqual([])
    expect(dumped('echo hi | cat')).toEqual([])
  })

  test('the file name only quoted, or inside text that is not a command', async () => {
    expect(dumped("echo 'cat PROGRESS.md'")).toEqual([])
    expect(dumped('echo "never cat PROGRESS.md whole"')).toEqual([])
    expect(dumped('git commit -m "docs: stop running cat PROGRESS.md"')).toEqual([])
    expect(dumped("git commit -F - <<'EOF'\ncat PROGRESS.md\nEOF")).toEqual([])
    expect(dumped("cat > notes.md <<'EOF'\ncat PROGRESS.md\nless PROGRESS.md\nEOF")).toEqual([])
    expect(dumped('# cat PROGRESS.md')).toEqual([])
    expect(dumped('printf "%s\\n" "cat PROGRESS.md"')).toEqual([])
  })

  test('a path made of a variable is not guessed at', async () => {
    expect(dumped('cat $TMPDIR/cola-bdns.jsonl')).toEqual([])
    expect(dumped('cat "$TMPDIR/Modelfile"')).toEqual([])
  })

  test('commands and quotes that are broken do not throw', async () => {
    for (const text of ['', ' ', 'cat "PROGRESS.md', "cat 'PROGRESS.md", 'cat $(', 'cat `', 'echo <<', '((', '))', '&&', 'cat <', 'x |', '\\']) {
      expect(Array.isArray(parseSteps(text, IN_REPO))).toBe(true)
    }
  })

  test('random text of shell characters never throws', async () => {
    const alphabet = ['cat', 'PROGRESS.md', ' ', '"', "'", '$(', ')', '`', '|', '&', ';', '<', '>', '<<', '\n', '\\', '#', '{', '}', '*', '~', '$X', 'cd', 'bash -c', 'uv run python -m boe_agent.comandos.barrido', '2025-01-01']
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let n = 0; n < 400; n++) {
      let text = ''
      for (let k = 0; k < 12; k++) text += alphabet[Math.floor(rand() * alphabet.length)] ?? ''
      expect(Array.isArray(dumpTargets(text, IN_REPO))).toBe(true)
      expect(Array.isArray(findLoads(text, IN_REPO))).toBe(true)
    }
  })
})

describe('parseSteps', () => {
  test('keeps what a step needs and drops the shell around it', async () => {
    const steps = parseSteps(
      'export BOE_AGENT_DSN=postgresql://boe:boe@localhost:5433/boe; cd boe-agent && FOO=1 nohup uv run python -m boe_agent.comandos.cola estado bdns 2025-01-01 2025-01-31 2>/dev/null | head -5',
      ABOVE,
    )
    expect(steps.map(s => s.words.slice(0, 3))).toEqual([['uv', 'run', 'python'], ['head', '-5']])
    expect(steps[0]?.dir).toBe(ROOT)
    expect(steps[0]?.after).toEqual(['head'])
    expect(steps[0]?.words).not.toContain('2>/dev/null')
  })

  test('fills in variables set earlier in the command', async () => {
    const steps = parseSteps('DESDE=2025-07-01; HASTA=2025-12-31; echo $DESDE ${HASTA} "$DESDE" \'$DESDE\' $OTHER', IN_REPO)
    expect(steps[0]?.words).toEqual(['echo', '2025-07-01', '2025-12-31', '2025-07-01', '$DESDE', '$OTHER'])
  })
})

// ---------------------------------------------------------------- loads

const load = (command: string, ctx = IN_REPO) => findLoads(command, ctx)
const U = 'uv run python -m boe_agent.comandos'

describe('findLoads: the real load commands', () => {
  test('BDNS: one day, and a range', async () => {
    expect(load(`${U}.ingesta_de_un_dia 2026-09-03`)).toEqual([
      { module: 'ingesta_de_un_dia', source: 'bdns', dir: ROOT, from: '2026-09-03', to: '2026-09-03', months: ['2026-09'], note: undefined },
    ])
    expect(load(`${U}.barrido 2026-09-01 2026-09-12`)).toEqual([
      { module: 'barrido', source: 'bdns', dir: ROOT, from: '2026-09-01', to: '2026-09-12', months: ['2026-09'], note: undefined },
    ])
  })

  test('BOE: one day, a range, and the re-ask flags', async () => {
    expect(load(`${U}.recogida_boe 2025-03-12`)[0]).toMatchObject({ source: 'boe', months: ['2025-03'], from: '2025-03-12' })
    expect(load(`${U}.recogida_boe --re-observar 2025-03-12`)[0]).toMatchObject({
      source: 'boe',
      months: ['2025-03'],
      note: 're-asks BOE for the announcements already stored',
    })
    expect(load(`${U}.barrido_boe 2025-01-01 2025-01-31`)[0]).toMatchObject({ source: 'boe', months: ['2025-01'], to: '2025-01-31' })
    expect(load(`${U}.barrido_boe --re-observar 2025-01-01 2025-01-31`)[0]).toMatchObject({ source: 'boe', months: ['2025-01'] })
  })

  test('a range over several months names them all', async () => {
    const [found] = load(`${U}.barrido 2025-07-01 2025-12-31`)
    expect(found?.months).toEqual(['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'])
    expect(describeLoad(found as NonNullable<typeof found>)).toBe(
      'BDNS (infosubvenciones.es), months 2025-07 to 2025-12 (6 months), days 2025-07-01 to 2025-12-31',
    )
    expect(load(`${U}.barrido 2025-12-15 2026-01-10`)[0]?.months).toEqual(['2025-12', '2026-01'])
  })

  test('the queue: procesar loads, the other subcommands do not', async () => {
    expect(load(`${U}.cola procesar bdns --maximo 31`)[0]).toMatchObject({ module: 'cola', source: 'bdns' })
    expect(load(`${U}.cola procesar boe --maximo 31`)[0]).toMatchObject({ module: 'cola', source: 'boe' })
    expect(load(`${U}.cola procesar bdns`)[0]).toMatchObject({ source: 'bdns' })
    expect(load(`${U}.cola procesar bdns --maximo 31`)[0]?.months).toBeUndefined()
    expect(load(`${U}.cola procesar bdns --maximo 31`)[0]?.note).toContain('names no month')
    expect(load(`${U}.cola procesar bdns --maximo 31`)[0]?.note).toContain('at most 31 days')
    expect(load(`${U}.cola estado bdns 2025-01-01 2025-01-31`)).toEqual([])
    expect(load(`${U}.cola encolar bdns 2025-01-01 2025-01-31`)).toEqual([])
    expect(load(`${U}.cola encolar boe 2025-01-01 2025-01-31`)).toEqual([])
    expect(load(`${U}.cola rebarrer bdns 2025-01-01 2025-01-31`)).toEqual([])
    expect(load(`${U}.cola reabrir bdns 2025-01-03 2025-01-03`)).toEqual([])
  })

  test('the runbook line, with its stderr redirect and a background &', async () => {
    const found = load('uv run python -m boe_agent.comandos.cola procesar bdns --maximo 31 2> "$TMPDIR/cola-bdns.jsonl" &')
    expect(found).toHaveLength(1)
    expect(found[0]?.source).toBe('bdns')
    expect(load('uv run python -m boe_agent.comandos.cola procesar boe --maximo 31 2>registro.jsonl')).toHaveLength(1)
  })

  test('two loads in one command are both found', async () => {
    const found = load(`${U}.cola procesar bdns --maximo 31 & ${U}.cola procesar boe --maximo 31 & wait`)
    expect(found.map(f => f.source)).toEqual(['bdns', 'boe'])
    expect(loadReason(found)).toContain('makes 2 loads')
  })
})

describe('findLoads: command shapes', () => {
  const day = `boe_agent.comandos.barrido 2026-09-01 2026-09-12`

  test('uv run in its forms, and plain python', async () => {
    for (const command of [
      `uv run python -m ${day}`,
      `uv run --extra dev python -m ${day}`,
      `uv run --python 3.12 python -m ${day}`,
      `uv run -m ${day}`,
      `python -m ${day}`,
      `python3 -m ${day}`,
      `python3.12 -m ${day}`,
      `.venv/bin/python -m ${day}`,
      `${ROOT}/.venv/bin/python3 -m ${day}`,
      `uv run python -mboe_agent.comandos.barrido 2026-09-01 2026-09-12`,
      `uv run python -u -m ${day}`,
      `BOE_AGENT_DSN=postgresql://boe:boe@localhost:5433/boe uv run python -m ${day}`,
      `BOE_AGENT_DSN=postgresql://boe:boe@localhost:5433/boe PYTHONDONTWRITEBYTECODE=1 uv run python -m ${day}`,
      `env BOE_AGENT_DSN=postgresql://boe:boe@localhost:5433/boe uv run python -m ${day}`,
      `export BOE_AGENT_DSN=postgresql://boe:boe@localhost:5433/boe PYTHONDONTWRITEBYTECODE=1; uv run python -m ${day}`,
      `time uv run python -m ${day}`,
      `nohup uv run python -m ${day} > /tmp/out.log 2>&1 &`,
      `caffeinate -i uv run python -m ${day}`,
      `uv run python -m ${day} 2>&1 | tee /tmp/barrido.log`,
      `uv run python -m ${day} | tail -20`,
      `bash -c 'uv run python -m ${day}'`,
      `zsh -ic "uv run python -m ${day}"`,
      `eval "uv run python -m ${day}"`,
      `echo start && uv run python -m ${day} && echo done`,
      `echo $(uv run python -m ${day})`,
    ]) {
      const found = load(command)
      expect(found.length).toBe(1)
      expect(found[0]).toMatchObject({ source: 'bdns', months: ['2026-09'] })
    }
  })

  test('cd boe-agent && ..., and uv run --directory', async () => {
    const above = load(`cd boe-agent && uv run python -m ${day}`, ABOVE)
    expect(above[0]).toMatchObject({ dir: ROOT, months: ['2026-09'] })
    expect(load(`cd ${ROOT} && uv run python -m ${day}`, ABOVE)[0]?.dir).toBe(ROOT)
    expect(load(`cd ~/projects/boe-agent && uv run python -m ${day}`, ABOVE)[0]?.dir).toBe(ROOT)
    expect(load(`(cd boe-agent && uv run python -m ${day})`, ABOVE)[0]?.dir).toBe(ROOT)
    expect(load(`bash -lc 'cd boe-agent && uv run python -m ${day}'`, ABOVE)[0]?.dir).toBe(ROOT)
    expect(load(`uv run --directory boe-agent python -m ${day}`, ABOVE)[0]?.dir).toBe(ROOT)
    expect(load(`uv run --project=boe-agent python -m ${day}`, ABOVE)[0]?.dir).toBe(ROOT)
    // Without the cd the command runs where the session is.
    expect(load(`uv run python -m ${day}`, ABOVE)[0]?.dir).toBe('/Users/me/projects')
  })

  test('the runbook variables fill in, and an unknown one says so', async () => {
    const known = load(`DESDE=2025-07-01 HASTA=2025-12-31; uv run python -m boe_agent.comandos.barrido $DESDE $HASTA`)
    expect(known[0]?.months).toHaveLength(6)
    const unknown = load('uv run python -m boe_agent.comandos.barrido $DESDE $HASTA')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.months).toBeUndefined()
    expect(unknown[0]?.note).toContain('shell variable')
    expect(describeLoad(unknown[0] as NonNullable<(typeof unknown)[0]>)).toContain('BDNS (infosubvenciones.es), the month is not clear')
  })

  test('a command whose days cannot be read still asks, saying so', async () => {
    const bad = load(`${U}.barrido 2025-13-01 2025-13-31`)
    expect(bad).toHaveLength(1)
    expect(bad[0]?.note).toContain('not plain YYYY-MM-DD days')
    expect(load(`${U}.barrido 2025-01-01`)[0]?.note).toContain('not plain YYYY-MM-DD days')
    expect(load(`${U}.barrido 2025-01-01 2025-01-31 2025-02-01`)[0]?.note).toContain('not plain')
    expect(load(`${U}.ingesta_de_un_dia hoy`)[0]?.note).toContain('hoy')
  })

  test('a load hidden in python -c, or a braced module list, is found', async () => {
    expect(load("uv run python -c 'from boe_agent.comandos import barrido'")[0]).toMatchObject({ module: 'barrido', source: 'bdns' })
    expect(load("python -c 'import boe_agent.comandos.recogida_boe as r'")[0]).toMatchObject({ module: 'recogida_boe', source: 'boe' })
    expect(load(`${U}.{barrido,cola} 2025-01-01 2025-01-31`).map(l => l.module)).toEqual(['barrido'])
  })
})

describe('findLoads: near misses that must pass', () => {
  test('the read-only modes of the same commands', async () => {
    expect(load(`${U}.barrido --completitud 2025-01-01 2025-12-31`)).toEqual([])
    expect(load(`${U}.barrido_boe --completitud 2025-01-01 2025-01-31`)).toEqual([])
    expect(load('cd boe-agent && uv run python -m boe_agent.comandos.barrido --completitud 2025-01-01 2025-12-31', ABOVE)).toEqual([])
  })

  test('the commands that read or project from the database, or ask nothing of BDNS or BOE', async () => {
    for (const rest of [
      'proyeccion 2026-09-01 2026-09-12',
      'proyeccion --reprocesar-cuarentena',
      'proyeccion_boe 2025-03-12',
      'proyeccion_boe 2025-01-01 2025-01-31',
      'entidades',
      'convocantes',
      'organos',
      'rutas',
      'cobertura',
      'cobertura 2025-01 2025-02',
      'retrasos',
      'buscar "cruz roja"',
      'metricas 2025-01',
      'ficha "cruz roja"',
      'evaluar_ruta',
      'evaluar_preguntas gemma4:latest desarrollo',
      'modelfile gemma4:latest',
      'web',
      '{cobertura,metricas,retrasos}',
    ]) {
      expect(load(`${U}.${rest}`)).toEqual([])
    }
  })

  test('a load command run with no arguments prints its usage and sends nothing', async () => {
    expect(load(`${U}.barrido`)).toEqual([])
    expect(load(`${U}.cola`)).toEqual([])
    expect(load(`${U}.recogida_boe`)).toEqual([])
  })

  test('tests, linters and other uses of -m', async () => {
    expect(load('uv run pytest')).toEqual([])
    expect(load('uv run pytest -m red tests/fuentes')).toEqual([])
    expect(load('uv run pytest tests/comandos/test_barrido.py -q')).toEqual([])
    expect(load('uv run python -m pytest -m "not db and not red"')).toEqual([])
    expect(load('uv run ruff check')).toEqual([])
    expect(load('uv run mypy')).toEqual([])
    expect(load('uv run python -m tests.apoyo.mutar src/x.py a b -- tests/x.py -q')).toEqual([])
    expect(load('uv sync --extra dev')).toEqual([])
    expect(load('python -m http.server')).toEqual([])
  })

  test('the module name only quoted, searched for, or inside text', async () => {
    expect(load("grep -rn 'boe_agent.comandos.barrido' src/")).toEqual([])
    expect(load('rg boe_agent.comandos.cola docs')).toEqual([])
    expect(load('cat src/boe_agent/comandos/barrido.py')).toEqual([])
    expect(load('ls src/boe_agent/comandos')).toEqual([])
    expect(load(`echo '${U}.barrido 2025-01-01 2025-01-31'`)).toEqual([])
    expect(load(`git commit -m "docs: run ${U}.barrido 2025-01-01 2025-01-31 first"`)).toEqual([])
    expect(load(`git commit -F - <<'EOF'\nrun ${U}.barrido 2025-01-01 2025-01-31\nEOF`)).toEqual([])
    expect(load(`cat > notes.md <<'EOF'\n${U}.cola procesar bdns --maximo 31\nEOF`)).toEqual([])
    expect(load(`# ${U}.barrido 2025-01-01 2025-01-31`)).toEqual([])
  })

  test('the taxonomy load and the reconciliation are not month loads and pass', async () => {
    expect(load(`${U}.taxonomias`)).toEqual([])
    expect(load(`${U}.conciliacion 2025`)).toEqual([])
  })
})

describe('months and dates', () => {
  test('validates ISO days', async () => {
    expect(isIsoDay('2025-02-28')).toBe(true)
    expect(isIsoDay('2024-02-29')).toBe(true)
    expect(isIsoDay('2025-02-29')).toBe(false)
    expect(isIsoDay('2025-13-01')).toBe(false)
    expect(isIsoDay('2025-1-1')).toBe(false)
    expect(isIsoDay('$DESDE')).toBe(false)
  })

  test('lists the months a range touches, whichever way it is given', async () => {
    expect(monthsBetween('2025-03-12', '2025-03-12')).toEqual(['2025-03'])
    expect(monthsBetween('2025-11-30', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(monthsBetween('2025-02-01', '2025-01-01')).toEqual(['2025-01', '2025-02'])
  })
})

describe('the question text', () => {
  test('names the source and the month, and what to do if nobody can answer', async () => {
    const reason = loadReason(load(`${U}.recogida_boe 2025-03-12`))
    expect(reason).toContain('BOE section 5A (boe.es)')
    expect(reason).toContain('month 2025-03')
    expect(reason).toContain('day 2025-03-12')
    expect(reason).toContain('ask the user in chat')
  })

  test('says plainly when the month is not in the command', async () => {
    const reason = loadReason(load(`${U}.cola procesar bdns --maximo 31`))
    expect(reason).toContain('BDNS (infosubvenciones.es)')
    expect(reason).toContain('names no month')
  })
})
