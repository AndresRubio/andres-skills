import { describe, expect, test } from 'claude-code/testing'

import {
  BUILT_IN,
  agentOf,
  denyFailed,
  denyMissing,
  denyUnknown,
  frontmatter,
  gaps,
  installPaths,
  isFork,
  openIn,
  pluginType,
  projectDirs,
  routesOf,
  typeOf,
} from '../hooks/logic'

const SCOUT = [
  '---',
  'name: scout',
  'description: Finds files and reads logs. It edits no code.',
  'model: haiku',
  'effort: medium',
  'tools: Read, Grep, Glob, Bash',
  '---',
  '',
  'You find things and report them.',
].join('\n')

describe('what a call leaves open', () => {
  test('a call with neither leaves both, and each one it sets closes that one', async () => {
    expect(openIn({ description: 'd', prompt: 'p' })).toEqual(['model', 'effort'])
    expect(openIn({ model: 'haiku' })).toEqual(['effort'])
    expect(openIn({ effort: 'low' })).toEqual(['model'])
    expect(openIn({ model: 'opus', effort: 'high' })).toEqual([])
  })

  test('an empty or non-text value sets nothing', async () => {
    expect(openIn({ model: '', effort: '  ' })).toEqual(['model', 'effort'])
    expect(openIn({ model: null, effort: undefined })).toEqual(['model', 'effort'])
    expect(openIn({ model: true, effort: {} })).toEqual(['model', 'effort'])
  })

  test('the type is the one named, else general-purpose', async () => {
    expect(typeOf({ subagent_type: 'Explore' })).toBe('Explore')
    expect(typeOf({ subagent_type: ' router:scout ' })).toBe('router:scout')
    expect(typeOf({})).toBe('general-purpose')
    expect(typeOf({ subagent_type: '' })).toBe('general-purpose')
    expect(typeOf({ subagent_type: 7 })).toBe('general-purpose')
  })

  test('only the type fork is a fork', async () => {
    expect(isFork({ subagent_type: 'fork' })).toBe(true)
    expect(isFork({ subagent_type: 'Fork' })).toBe(false)
    expect(isFork({ subagent_type: 'my:fork' })).toBe(false)
    expect(isFork({})).toBe(false)
  })

  test('a gap is what neither the call nor the definition fixes', async () => {
    expect(gaps(['model', 'effort'], {})).toEqual(['model', 'effort'])
    expect(gaps(['model', 'effort'], { model: 'haiku' })).toEqual(['effort'])
    expect(gaps(['model', 'effort'], { model: 'haiku', effort: 'low' })).toEqual([])
    expect(gaps(['effort'], { model: 'haiku' })).toEqual(['effort'])
    expect(gaps([], {})).toEqual([])
  })
})

describe('built-in types', () => {
  test('the four that inherit fix nothing, and the two helpers fix a model alone', async () => {
    for (const type of ['general-purpose', 'Explore', 'Plan', 'claude']) expect(BUILT_IN[type]).toEqual({})
    expect(BUILT_IN['statusline-setup']).toEqual({ model: 'sonnet' })
    expect(BUILT_IN['claude-code-guide']).toEqual({ model: 'haiku' })
    expect(BUILT_IN.scout).toBeUndefined()
  })
})

describe('frontmatter', () => {
  test('reads the top-level keys of an agent file', async () => {
    expect(frontmatter(SCOUT)).toEqual({
      name: 'scout',
      description: 'Finds files and reads logs. It edits no code.',
      model: 'haiku',
      effort: 'medium',
      tools: 'Read, Grep, Glob, Bash',
    })
  })

  test('drops quotes and comments, and takes Windows line ends and a byte order mark', async () => {
    const text = '\uFEFF---\r\nname: "a b"\r\nmodel: \'opus\'  # the big one\r\neffort: high # raised\r\n---\r\nbody'
    expect(frontmatter(text)).toEqual({ name: 'a b', model: 'opus', effort: 'high' })
  })

  test('skips nested keys, list items and a key with no value', async () => {
    const text = '---\nname: x\ntools:\n  - Read\n  - Bash\nhooks:\n  model: fake\nmodel:\n---\n'
    expect(frontmatter(text)).toEqual({ name: 'x', tools: '', hooks: '', model: '' })
  })

  test('a file with no frontmatter, or one that never closes, has none', async () => {
    expect(frontmatter('model: haiku\n')).toBeUndefined()
    expect(frontmatter('---\nmodel: haiku\n')).toBeUndefined()
    expect(frontmatter('')).toBeUndefined()
    expect(frontmatter('text\n---\nmodel: haiku\n---\n')).toBeUndefined()
  })

  test('a model in the body is not the definition\'s', async () => {
    expect(frontmatter('---\nname: x\n---\nmodel: opus\n')).toEqual({ name: 'x' })
  })
})

describe('agentOf', () => {
  test('gives the name, the description and what the file fixes', async () => {
    expect(agentOf(SCOUT, 'scout.md')).toEqual({
      name: 'scout',
      description: 'Finds files and reads logs. It edits no code.',
      definition: { model: 'haiku', effort: 'medium' },
    })
  })

  test('the name falls back to the file\'s', async () => {
    expect(agentOf('---\nmodel: sonnet\n---\n', 'security.md').name).toBe('security')
    expect(agentOf('no frontmatter', 'notes.md')).toEqual({ name: 'notes', description: '', definition: {} })
  })

  test('inherit, an empty value and a missing key fix nothing', async () => {
    expect(agentOf('---\nname: a\nmodel: inherit\neffort: high\n---\n', 'a.md').definition).toEqual({ effort: 'high' })
    expect(agentOf('---\nname: a\nmodel:\neffort: ""\n---\n', 'a.md').definition).toEqual({})
    expect(agentOf('---\nname: a\n---\n', 'a.md').definition).toEqual({})
  })

  test('a full model id counts as a model', async () => {
    expect(agentOf('---\nname: a\nmodel: claude-opus-5-5\n---\n', 'a.md').definition).toEqual({ model: 'claude-opus-5-5' })
  })
})

describe('pluginType', () => {
  test('splits the plugin, the folders and the name', async () => {
    expect(pluginType('router:scout')).toEqual({ plugin: 'router', folders: [], name: 'scout' })
    expect(pluginType('my-plugin:review:security')).toEqual({ plugin: 'my-plugin', folders: ['review'], name: 'security' })
  })

  test('a type with no colon, or with an empty part, is no plugin type', async () => {
    expect(pluginType('Explore')).toBeUndefined()
    expect(pluginType('router:')).toBeUndefined()
    expect(pluginType(':scout')).toBeUndefined()
    expect(pluginType('a::b')).toBeUndefined()
  })
})

describe('projectDirs', () => {
  test('goes from the session folder up to the repository root, nearest first', async () => {
    expect(projectDirs('/work/repo/packages/api', '/work/repo')).toEqual(['/work/repo/packages/api', '/work/repo/packages', '/work/repo'])
    expect(projectDirs('/work/repo', '/work/repo')).toEqual(['/work/repo'])
    expect(projectDirs('/work/repo/', '/work/repo/')).toEqual(['/work/repo'])
  })

  test('outside a repository, or under another root, it is the session folder alone', async () => {
    expect(projectDirs('/work/loose', undefined)).toEqual(['/work/loose'])
    expect(projectDirs('/work/repo-two/src', '/work/repo')).toEqual(['/work/repo-two/src'])
    expect(projectDirs('/', undefined)).toEqual(['/'])
  })
})

describe('installPaths', () => {
  const file = JSON.stringify({
    version: 2,
    plugins: {
      'superpowers@superpowers-marketplace': [{ scope: 'user', installPath: '/cache/superpowers/7.0.2' }],
      'guards@andres-skills': [
        { scope: 'user', installPath: '/cache/guards/0.1.1' },
        { scope: 'local', installPath: '/cache/guards/0.1.0' },
        { scope: 'local', installPath: '/cache/guards/0.1.1' },
      ],
      'guards@other': [{ installPath: '/cache/other/guards/2' }],
      'guards-extra@andres-skills': [{ installPath: '/cache/guards-extra/1' }],
      'broken@x': 'nope',
    },
  })

  test('gives each folder the plugin is installed in, once', async () => {
    expect(installPaths(file, 'superpowers')).toEqual(['/cache/superpowers/7.0.2'])
    expect(installPaths(file, 'guards')).toEqual(['/cache/guards/0.1.1', '/cache/guards/0.1.0', '/cache/other/guards/2'])
  })

  test('a plugin that is not there, or whose entry is no list, has none', async () => {
    expect(installPaths(file, 'router')).toEqual([])
    expect(installPaths(file, 'broken')).toEqual([])
    expect(installPaths('{"plugins": {}}', 'guards')).toEqual([])
  })

  test('text that is not that file throws', async () => {
    expect(() => installPaths('not json', 'guards')).toThrow()
    expect(() => installPaths('[]', 'guards')).toThrow('no "plugins" object')
    expect(() => installPaths('{"plugins": null}', 'guards')).toThrow('no "plugins" object')
  })
})

describe('routesOf', () => {
  const agent = (name: string, model?: string, effort?: string) => ({
    name,
    description: `${name} work.`,
    definition: { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) },
  })

  test('orders the agents from the cheapest model up', async () => {
    const routes = routesOf([agent('lead', 'fable', 'medium'), agent('implementer', 'sonnet', 'medium'), agent('scout', 'haiku', 'medium'), agent('reviewer', 'opus', 'medium')])
    expect(routes.map(route => `${route.agent}:${route.model}:${route.effort}`)).toEqual([
      'scout:haiku:medium',
      'implementer:sonnet:medium',
      'reviewer:opus:medium',
      'lead:fable:medium',
    ])
  })

  test('leaves out an agent that does not fix both, and puts an unknown model last', async () => {
    const routes = routesOf([agent('b', 'claude-opus-5-5', 'high'), agent('half', 'haiku'), agent('none'), agent('a', 'haiku', 'low')])
    expect(routes.map(route => route.agent)).toEqual(['a', 'b'])
  })
})

describe('the refusals', () => {
  const routes = [
    { agent: 'scout', model: 'haiku', effort: 'medium', description: 'Finds files.' },
    { agent: 'lead', model: 'fable', effort: 'medium', description: 'Takes the hardest work.' },
  ]

  test('a call with no model says what is missing, why it matters and what to do, and lists the agents', async () => {
    const text = denyMissing('router', 'general-purpose', ['model', 'effort'], routes)
    expect(text).toContain('router: this Agent call sets no model and no effort')
    expect(text).toContain('neither does its agent type `general-purpose`')
    expect(text).toContain("would take the session's")
    expect(text).toContain('with `model` and `effort` on the call')
    expect(text).toContain('- `router:scout` (haiku, medium): Finds files.\n- `router:lead` (fable, medium): Takes the hardest work.')
    expect(text).toContain('`subagent_type: "fork"` is not checked')
  })

  test('a call with a model and no effort gets the short text, with no list', async () => {
    const text = denyMissing('router', 'claude-code-guide', ['effort'], [])
    expect(text).toContain('sets no effort, and neither does its agent type `claude-code-guide`')
    expect(text).toContain('Call it again with `effort` on the call')
    expect(text).toContain('"high" for bug fixes')
    expect(text).not.toContain('`router:')
  })

  test('a call with an effort and no model asks for the model alone', async () => {
    const text = denyMissing('router', 'Explore', ['model'], routes)
    expect(text).toContain('sets no model, and neither')
    expect(text).toContain('or with `model` on the call')
    expect(text).toContain('`router:scout`')
  })

  test('a type with no readable definition says so and asks for both on the call', async () => {
    const text = denyUnknown('router', 'acme:auditor', ['model', 'effort'], routes)
    expect(text).toContain('the definition of its agent type `acme:auditor` could not be found')
    expect(text).toContain("can't tell whether the type sets its own")
    expect(text).toContain('Call it again with `model` and `effort` on the call')
    expect(text).toContain('`router:lead` (fable, medium)')
  })

  test('a failed check says why and how to get past it', async () => {
    expect(denyFailed('router', 'EACCES')).toContain('failed (EACCES), so the call was stopped')
    expect(denyFailed('router', undefined)).toContain('failed (no reason given)')
    expect(denyFailed('router', 'x')).toContain('with `model` and `effort` on the call, which needs no lookup')
  })
})
