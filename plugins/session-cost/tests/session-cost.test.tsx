import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, Register } from 'claude-code'

const BAND = {
  plugin: 'session-cost',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model: 'claude-opus-5-5',
})

const stepResult = (u: ReturnType<typeof usage> | null) => ({
  turnId: 't1',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: u === null ? null : ('end_turn' as const),
  usage: u,
})

const stepArgs = (agentId?: string) => ({
  turnId: 't1',
  index: 0,
  model: 'claude-opus-5-5',
  messageCount: 1,
  ...(agentId === undefined ? {} : { agentId }),
})

/** Reads a streaming event to its end and settles with its result. */
const drain = async <C, R>(stream: AsyncGenerator<C, R> & { readonly result: Promise<R> }) => {
  for await (const _ of stream) {
    // The chunks are not under test.
  }
  return stream.result
}

const COST = (usd: number) => ({
  value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd } },
})

/** Draws the band and reads every line of text in it, top to bottom. */
const bandLines = async (
  $: Parameters<TestBody>[0],
  surface: 'terminal' | 'desktop' = 'desktop',
  props: typeof BAND.props | (Omit<typeof BAND.props, 'hasSurvey'> & { hasSurvey: true }) = BAND.props,
) => {
  const ui = await $.ui.mount({ ...BAND, surface, props })
  const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return lines
}

/** Stands for the engine beneath the plugins: an empty band. */
const engineDrawsNothing = (on: On) =>
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

// Another mod drawing in the band with no plugin matcher, as check-gate does.
const otherBand: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other</Text>
  })
}

const EMPTY = 'Sesión: 0 tokens (0 de caché)'

test('each response adds up, subagents included, and the band shows it', async ($, on) => {
  const answers = [usage(1000, 500, 20_000, 3000), usage(200, 100, 15_000, 0)]
  on('turn.step', async function* () {
    return stepResult(answers.shift() ?? null)
  })
  on('session.usage', () => COST(1.5))
  engineDrawsNothing(on)

  await drain($.turn.step(stepArgs()))
  await drain($.turn.step(stepArgs('sub-1')))

  for (const surface of ['terminal', 'desktop'] as const) {
    // 1000+500+20000+3000 + 200+100+15000 = 39 800; cache 38 000; last 15 300
    expect(await bandLines($, surface)).toEqual([
      'Sesión: 39,8 k tokens (38,0 k de caché) · ~1,50 $ · última llamada +15,3 k',
    ])
  }
})

test('responses that finish together are all counted', async ($, on) => {
  on('turn.step', async function* () {
    return stepResult(usage(100, 0, 0, 0))
  })
  on('session.usage', () => COST(0.1))
  engineDrawsNothing(on)

  await Promise.all(Array.from({ length: 8 }, (_, i) => drain($.turn.step(stepArgs(`sub-${i}`)))))

  expect(await bandLines($)).toEqual(['Sesión: 800 tokens (0 de caché) · ~0,10 $ · última llamada +100'])
})

test('a response with no usage changes nothing', async ($, on) => {
  on('turn.step', async function* () {
    return stepResult(null)
  })
  engineDrawsNothing(on)

  await drain($.turn.step(stepArgs()))

  expect(await bandLines($)).toEqual([EMPTY])
})

test('the measurement after a turn updates the cost', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  engineDrawsNothing(on)

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [],
    cost: { usd: 2.25 },
    changed: ['cost'],
  })

  expect(await bandLines($)).toEqual(['Sesión: 0 tokens (0 de caché) · ~2,25 $'])
})

test('/clear starts the count over', async ($, on) => {
  on('turn.step', async function* () {
    return stepResult(usage(500, 500, 0, 0))
  })
  on('session.usage', () => COST(1))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  engineDrawsNothing(on)

  await drain($.turn.step(stepArgs()))
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  expect(await bandLines($)).toEqual([EMPTY])
})

test('the band steps aside for a survey', async ($, on) => {
  // Stands for the engine's survey, drawn beneath the plugins.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })

  expect(await bandLines($, 'desktop', { ...BAND.props, hasSurvey: true })).toEqual(['survey'])
})

test("a mod drawing beneath keeps its row, with the count under it", {
  plugins: [{ name: 'other-band', tier: 'append', register: otherBand }],
}, async ($, on) => {
  engineDrawsNothing(on)

  expect(await bandLines($)).toEqual(['other', EMPTY])
})
