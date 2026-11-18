import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { addUsage, emptyTotals, formatRow, withCost } from './logic'

const totals = atom({ plugin: 'session-cost', key: 'totals' } as const, emptyTotals())

// update() retries on a conflicting write, so responses that finish together
// all land as long as each change is computed inside it from the value it gets.
export const register: Register = on => {
  // Every model response, the main thread's and each subagent's.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null) {
      const { cost } = await $.session.usage()
      await update($, totals, t => withCost(addUsage(t, usage), cost))
    }
    return result
  })

  // The engine's own measurement after each turn settles the dollar figure.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('cost')) await update($, totals, t => withCost(t, e.cost))
    return next(e)
  })

  // /clear starts the session's figures over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, totals, () => emptyTotals())
    return next(e)
  })

  // On engines where the first band hook to return a tree takes the whole band
  // (2.1.317), a row drawn beneath this one, such as check-gate's, stays on top.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Text dimColor>{formatRow(await read($, totals))}</Text>
      </Box>
    )
  })
}
