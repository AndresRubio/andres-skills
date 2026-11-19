import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

const HOME = '/Users/me'
const REPO = '/work/repo'
const CACHE = `${HOME}/.claude/plugins/cache`
// Stands for this plugin's folder, wherever the test run has it.
const OWN = 'OWN'

const agent = (fields: Record<string, string>, body = 'Do the work.') =>
  ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', '', body].join('\n')

// The four agents the plugin ships, as their frontmatter fixes them.
const SHIPPED = {
  [`${OWN}/agents/scout.md`]: agent({ name: 'scout', description: 'Finds files and reads logs.', model: 'haiku', effort: 'medium', tools: 'Read, Grep, Glob, Bash' }),
  [`${OWN}/agents/implementer.md`]: agent({ name: 'implementer', description: 'Does well-scoped work.', model: 'sonnet', effort: 'medium' }),
  [`${OWN}/agents/reviewer.md`]: agent({ name: 'reviewer', description: 'Does judgment work without editing files.', model: 'opus', effort: 'medium' }),
  [`${OWN}/agents/lead.md`]: agent({ name: 'lead', description: 'Takes the hardest work.', model: 'fable', effort: 'medium' }),
}

const INSTALLED = `${HOME}/.claude/plugins/installed_plugins.json`
const installed = (plugins: Record<string, string[]>) =>
  JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(plugins).map(([key, paths]) => [key, paths.map(installPath => ({ scope: 'user', installPath }))])) })

type World = {
  cwd: string
  // The repository root git reports; undefined outside a repository.
  root: string | undefined
  env: Record<string, string>
  files: Record<string, string>
  // What each dependency does when asked: answer, or reject.
  isGitBroken: boolean
  isCwdBroken: boolean
  brokenLists: string[]
  brokenReads: string[]
  // What the test saw.
  ran: Record<string, unknown>[]
  asked: string[]
}

const ok = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands for the engine, git and the file system beneath the plugin.
function setup(on: On, overrides: Partial<World> = {}): World {
  const world: World = {
    cwd: REPO,
    root: REPO,
    env: { HOME },
    files: { ...SHIPPED },
    isGitBroken: false,
    isCwdBroken: false,
    brokenLists: [],
    brokenReads: [],
    ran: [],
    asked: [],
    ...overrides,
  }
  // The plugin's own folder is a real path that differs per machine.
  const spelled = (path: string) =>
    path.startsWith(`${HOME}/`) || path.startsWith('/work/') || path.startsWith('/etc/') ? path : path.replace(/^.*\/agents(?=\/|$)/, `${OWN}/agents`)
  const isDir = (path: string) => Object.keys(world.files).some(file => file.startsWith(`${path}/`))

  mock.env(on, world.env)
  on('session.cwd', () => (world.isCwdBroken ? { deny: 'no session folder' } : { value: world.cwd }))
  on('process.run', (_, e) => {
    if (e.argv.join(' ') !== 'git rev-parse --show-toplevel') throw new Error(`unexpected command: ${e.argv.join(' ')}`)
    world.asked.push(`git ${e.init?.cwd ?? ''}`)
    if (world.isGitBroken) return { deny: 'git is gone' }
    return world.root === undefined ? ok('', 128) : ok(`${world.root}\n`)
  })
  on('fs.exists', (_, e) => {
    const path = spelled(e.path)
    world.asked.push(`exists ${path}`)
    return { value: path in world.files || isDir(path) }
  })
  on('fs.list', (_, e) => {
    const path = spelled(e.path)
    world.asked.push(`list ${path}`)
    if (world.brokenLists.includes(path)) return { deny: 'EACCES' }
    if (!isDir(path)) return { deny: 'ENOENT' }
    const names = new Set(Object.keys(world.files).filter(file => file.startsWith(`${path}/`)).map(file => file.slice(path.length + 1)))
    const entries = new Map<string, 'file' | 'dir'>()
    for (const name of names) entries.set(name.split('/')[0] ?? '', name.includes('/') ? 'dir' : 'file')
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    const path = spelled(e.path)
    world.asked.push(`read ${path}`)
    const text = world.files[path]
    if (world.brokenReads.includes(path) || text === undefined) return { deny: 'ENOENT' }
    return { value: text }
  })
  on('tool.call', (_, e) => {
    world.ran.push({ ...e })
    return { result: {} }
  })
  return world
}

type Called = { deny?: string; isError?: boolean; text?: string }
type Caller = { tool: { call: (input: never) => Promise<unknown> } }

// What the model reads when the Agent call was refused, else undefined.
async function refusal($: Caller, input: Record<string, unknown> = {}): Promise<string | undefined> {
  const done = (await $.tool.call({ tool: 'Agent', description: 'echo probe', prompt: 'Run: echo router-probe.', ...input } as never)) as Called
  return done.deny ?? (done.isError ? done.text : undefined)
}

// ------------------------------------------------- the call a session sends

test('the call as a session sent it, with no model and no effort, is refused with the agents to pick from', async ($, on) => {
  const world = setup(on)

  // The tool_input a PreToolUse hook received for a real call on 2.1.317.
  const refused = await refusal($, { subagent_type: 'general-purpose', run_in_background: false })

  expect(refused).toContain('router: this Agent call sets no model and no effort')
  expect(refused).toContain('neither does its agent type `general-purpose`')
  expect(refused).toContain(
    [
      '- `router:scout` (haiku, medium): Finds files and reads logs.',
      '- `router:implementer` (sonnet, medium): Does well-scoped work.',
      '- `router:reviewer` (opus, medium): Does judgment work without editing files.',
      '- `router:lead` (fable, medium): Takes the hardest work.',
    ].join('\n'),
  )
  expect(world.ran).toEqual([])
})

test('a call that sets both runs as it is, and nothing is looked up', async ($, on) => {
  const world = setup(on)

  expect(await refusal($, { subagent_type: 'general-purpose', model: 'haiku', effort: 'low' })).toBeUndefined()
  expect(await refusal($, { subagent_type: 'not-defined-anywhere', model: 'opus', effort: 'high' })).toBeUndefined()

  expect(world.ran.map(call => [call.subagent_type, call.model, call.effort])).toEqual([
    ['general-purpose', 'haiku', 'low'],
    ['not-defined-anywhere', 'opus', 'high'],
  ])
  expect(world.asked).toEqual([])
})

test('a fork runs with neither, and nothing is looked up', async ($, on) => {
  const world = setup(on)

  expect(await refusal($, { subagent_type: 'fork' })).toBeUndefined()

  expect(world.ran).toHaveLength(1)
  expect(world.asked).toEqual([])
})

test('a call with no type is checked as general-purpose', async ($, on) => {
  const world = setup(on)

  expect(await refusal($)).toContain('its agent type `general-purpose`')
  expect(world.ran).toEqual([])
})

test('each missing setting is asked for by name', async ($, on) => {
  const world = setup(on)

  const noEffort = await refusal($, { subagent_type: 'Explore', model: 'haiku' })
  expect(noEffort).toContain('sets no effort, and neither does its agent type `Explore`')
  expect(noEffort).toContain('Call it again with `effort` on the call')
  expect(noEffort).not.toContain('`router:scout`')

  const noModel = await refusal($, { subagent_type: 'Plan', effort: 'high' })
  expect(noModel).toContain('sets no model, and neither does its agent type `Plan`')
  expect(noModel).toContain('`router:scout` (haiku, medium)')

  expect(world.ran).toEqual([])
})

test('a call from inside a subagent is checked the same way', async ($, on) => {
  const world = setup(on)

  expect(await refusal($, { subagent_type: 'Explore', agentId: 'a1' })).toContain('sets no model and no effort')
  expect(await refusal($, { subagent_type: 'router:scout', agentId: 'a1' })).toBeUndefined()

  expect(world.ran).toHaveLength(1)
})

// ------------------------------------------------------- what a type fixes

test('each agent the plugin ships runs with nothing on the call', async ($, on) => {
  const world = setup(on)

  for (const name of ['scout', 'implementer', 'reviewer', 'lead']) {
    expect(await refusal($, { subagent_type: `router:${name}` })).toBeUndefined()
  }

  expect(world.ran.map(call => call.subagent_type)).toEqual(['router:scout', 'router:implementer', 'router:reviewer', 'router:lead'])
  // Its own folder is read; installed_plugins.json is not.
  expect(world.asked).not.toContain(`read ${INSTALLED}`)
})

test('a shipped agent that lost a setting is refused like any other type', async ($, on) => {
  const world = setup(on, {
    files: { ...SHIPPED, [`${OWN}/agents/scout.md`]: agent({ name: 'scout', description: 'Finds files.', model: 'haiku' }) },
  })

  const refused = await refusal($, { subagent_type: 'router:scout' })

  expect(refused).toContain('sets no effort, and neither does its agent type `router:scout`')
  expect(await refusal($, { subagent_type: 'router:scout', effort: 'low' })).toBeUndefined()
  // An agent that no longer fixes both is not offered.
  expect(await refusal($, { subagent_type: 'Explore' })).not.toContain('`router:scout`')
  expect(world.ran).toHaveLength(1)
})

test('a built-in type with a model of its own needs only an effort', async ($, on) => {
  const world = setup(on)

  expect(await refusal($, { subagent_type: 'claude-code-guide' })).toContain('sets no effort, and neither does its agent type `claude-code-guide`')
  expect(await refusal($, { subagent_type: 'claude-code-guide', effort: 'low' })).toBeUndefined()
  expect(await refusal($, { subagent_type: 'statusline-setup', effort: 'low' })).toBeUndefined()

  expect(world.ran).toHaveLength(2)
})

test('a project agent that fixes both runs, from the session folder or a folder above it in the repository', async ($, on) => {
  const world = setup(on, {
    cwd: `${REPO}/packages/api`,
    files: {
      ...SHIPPED,
      [`${REPO}/.claude/agents/review/auditor.md`]: agent({ name: 'auditor', description: 'Audits.', model: 'opus', effort: 'high' }),
      [`${REPO}/packages/api/.claude/agents/tester.md`]: agent({ name: 'tester', description: 'Tests.', model: 'sonnet', effort: 'medium' }),
      [`${REPO}/.claude/agents/half.md`]: agent({ name: 'half', description: 'Half.', model: 'sonnet' }),
      // Above the repository, where Claude Code does not look.
      ['/work/.claude/agents/outside.md']: agent({ name: 'outside', description: 'Outside.', model: 'opus', effort: 'high' }),
    },
  })

  expect(await refusal($, { subagent_type: 'auditor' })).toBeUndefined()
  expect(await refusal($, { subagent_type: 'tester' })).toBeUndefined()
  expect(await refusal($, { subagent_type: 'half' })).toContain('sets no effort, and neither does its agent type `half`')
  expect(await refusal($, { subagent_type: 'outside' })).toContain('could not be found')

  expect(world.ran.map(call => call.subagent_type)).toEqual(['auditor', 'tester'])
  expect(world.asked).toContain(`git ${REPO}/packages/api`)
})

test('the nearest project file wins over one further up, and a project file over the user\'s', async ($, on) => {
  const world = setup(on, {
    cwd: `${REPO}/packages/api`,
    files: {
      ...SHIPPED,
      [`${REPO}/packages/api/.claude/agents/worker.md`]: agent({ name: 'worker', description: 'Near.' }),
      [`${REPO}/.claude/agents/worker.md`]: agent({ name: 'worker', description: 'Far.', model: 'opus', effort: 'high' }),
      [`${HOME}/.claude/agents/worker.md`]: agent({ name: 'worker', description: 'Mine.', model: 'opus', effort: 'high' }),
    },
  })

  expect(await refusal($, { subagent_type: 'worker' })).toContain('sets no model and no effort, and neither does its agent type `worker`')
  expect(world.ran).toEqual([])
})

test('a user agent is found by its name, in a subfolder too, and one named like a built-in replaces it', async ($, on) => {
  const world = setup(on, {
    root: undefined,
    cwd: '/work/loose',
    files: {
      ...SHIPPED,
      [`${HOME}/.claude/agents/research/deep.md`]: agent({ name: 'digger', description: 'Digs.', model: 'fable', effort: 'high' }),
      [`${HOME}/.claude/agents/explore.md`]: agent({ name: 'Explore', description: 'Cheap search.', model: 'haiku', effort: 'medium' }),
    },
  })

  expect(await refusal($, { subagent_type: 'digger' })).toBeUndefined()
  expect(await refusal($, { subagent_type: 'Explore' })).toBeUndefined()
  // The file's own name is not the agent's.
  expect(await refusal($, { subagent_type: 'deep' })).toContain('could not be found')

  expect(world.ran.map(call => call.subagent_type)).toEqual(['digger', 'Explore'])
})

test('CLAUDE_CONFIG_DIR moves where the user\'s agents are read from', async ($, on) => {
  const world = setup(on, {
    env: { HOME, CLAUDE_CONFIG_DIR: '/etc/claude' },
    files: {
      ...SHIPPED,
      ['/etc/claude/agents/moved.md']: agent({ name: 'moved', description: 'Moved.', model: 'sonnet', effort: 'low' }),
      [`${HOME}/.claude/agents/stale.md`]: agent({ name: 'stale', description: 'Stale.', model: 'sonnet', effort: 'low' }),
    },
  })

  expect(await refusal($, { subagent_type: 'moved' })).toBeUndefined()
  expect(await refusal($, { subagent_type: 'stale' })).toContain('could not be found')
  expect(world.ran).toHaveLength(1)
})

test('model: inherit fixes no model', async ($, on) => {
  const world = setup(on, {
    files: { ...SHIPPED, [`${REPO}/.claude/agents/mirror.md`]: agent({ name: 'mirror', description: 'Mirrors.', model: 'inherit', effort: 'high' }) },
  })

  expect(await refusal($, { subagent_type: 'mirror' })).toContain('sets no model, and neither does its agent type `mirror`')
  expect(await refusal($, { subagent_type: 'mirror', model: 'opus' })).toBeUndefined()
  expect(world.ran).toHaveLength(1)
})

test('an installed plugin\'s agent is read from its install folder, subfolders included', async ($, on) => {
  const world = setup(on, {
    files: {
      ...SHIPPED,
      [INSTALLED]: installed({ 'acme@market': [`${CACHE}/market/acme/1.0.0`], 'other@market': [`${CACHE}/market/other/2.0.0`] }),
      [`${CACHE}/market/acme/1.0.0/agents/auditor.md`]: agent({ name: 'auditor', description: 'Audits.', model: 'opus', effort: 'high' }),
      [`${CACHE}/market/acme/1.0.0/agents/review/security.md`]: agent({ description: 'Reviews.', model: 'opus', effort: 'high' }),
      [`${CACHE}/market/acme/1.0.0/agents/plain.md`]: agent({ name: 'plain', description: 'Plain.' }),
    },
  })

  expect(await refusal($, { subagent_type: 'acme:auditor' })).toBeUndefined()
  expect(await refusal($, { subagent_type: 'acme:review:security' })).toBeUndefined()
  expect(await refusal($, { subagent_type: 'acme:plain' })).toContain('sets no model and no effort, and neither does its agent type `acme:plain`')

  expect(world.ran.map(call => call.subagent_type)).toEqual(['acme:auditor', 'acme:review:security'])
})

// --------------------------------------------------- when it can't tell

test('a type with no definition it can read is refused, with what to pass', async ($, on) => {
  const world = setup(on, {
    files: { ...SHIPPED, [INSTALLED]: installed({ 'acme@market': [`${CACHE}/market/acme/1.0.0`] }), [`${CACHE}/market/acme/1.0.0/agents/auditor.md`]: agent({ name: 'auditor', description: 'Audits.', model: 'opus', effort: 'high' }) },
  })

  for (const type of ['from-the-agents-flag', 'acme:missing', 'not-installed:auditor', 'acme:deeper:auditor']) {
    const refused = await refusal($, { subagent_type: type })
    expect(refused).toContain(`the definition of its agent type \`${type}\` could not be found`)
    expect(refused).toContain('Call it again with `model` and `effort` on the call')
    expect(refused).toContain('`router:reviewer` (opus, medium)')
  }
  expect(await refusal($, { subagent_type: 'from-the-agents-flag', model: 'sonnet' })).toContain('with `effort` on the call')

  expect(world.ran).toEqual([])
})

test('with no installed_plugins.json, another plugin\'s agent can\'t be told', async ($, on) => {
  const world = setup(on)

  expect(await refusal($, { subagent_type: 'acme:auditor' })).toContain('could not be found')
  expect(world.ran).toEqual([])
})

test('a folder it can\'t list refuses the call', async ($, on) => {
  const world = setup(on, {
    files: { ...SHIPPED, [`${REPO}/.claude/agents/auditor.md`]: agent({ name: 'auditor', description: 'Audits.', model: 'opus', effort: 'high' }) },
    brokenLists: [`${REPO}/.claude/agents`],
  })

  const refused = await refusal($, { subagent_type: 'auditor' })

  expect(refused).toContain("router: the check of this Agent call's model and effort failed")
  expect(refused).toContain('with `model` and `effort` on the call')
  expect(await refusal($, { subagent_type: 'auditor', model: 'opus', effort: 'high' })).toBeUndefined()
  expect(world.ran).toHaveLength(1)
})

test('an agent file it can\'t read refuses the call', async ($, on) => {
  const world = setup(on, {
    files: { ...SHIPPED, [`${HOME}/.claude/agents/auditor.md`]: agent({ name: 'auditor', description: 'Audits.', model: 'opus', effort: 'high' }) },
    brokenReads: [`${HOME}/.claude/agents/auditor.md`],
  })

  expect(await refusal($, { subagent_type: 'auditor' })).toContain('failed')
  expect(world.ran).toEqual([])
})

test('git failing refuses the call', async ($, on) => {
  const gitGone = setup(on, { isGitBroken: true })
  expect(await refusal($, { subagent_type: 'Explore' })).toContain('failed')
  expect(gitGone.ran).toEqual([])
})

test('a session folder that can\'t be read refuses the call', async ($, on) => {
  const world = setup(on, { isCwdBroken: true })

  expect(await refusal($, { subagent_type: 'Explore' })).toContain('failed')
  expect(world.ran).toEqual([])
})

test('with HOME unset the user\'s folder can\'t be found, and the call is refused', async ($, on) => {
  const world = setup(on, { env: {} })

  const refused = await refusal($, { subagent_type: 'Explore' })

  expect(refused).toContain('failed')
  expect(refused).toContain('HOME is not set')
  expect(world.ran).toEqual([])
})

test('an installed_plugins.json that is not that file refuses the call', async ($, on) => {
  const world = setup(on, { files: { ...SHIPPED, [INSTALLED]: 'not json' } })

  expect(await refusal($, { subagent_type: 'acme:auditor' })).toContain('failed')
  expect(world.ran).toEqual([])
})

test('its own agents folder failing refuses the call instead of sending a list with nothing in it', async ($, on) => {
  const world = setup(on, { brokenLists: [`${OWN}/agents`] })

  expect(await refusal($, { subagent_type: 'Explore' })).toContain('failed')
  expect(await refusal($, { subagent_type: 'router:scout' })).toContain('failed')
  expect(world.ran).toEqual([])
})

test('more agent files than one lookup reads refuses the call', async ($, on) => {
  const many = Object.fromEntries(
    Array.from({ length: 301 }, (_, index) => [`${HOME}/.claude/agents/a${index}.md`, agent({ name: `a${index}`, description: 'One of many.' })]),
  )
  const world = setup(on, { files: { ...SHIPPED, ...many } })

  const refused = await refusal($, { subagent_type: 'zzz' })

  expect(refused).toContain('failed (more than 300 agent files to read)')
  expect(world.ran).toEqual([])
})
