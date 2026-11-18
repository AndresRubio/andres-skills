import { expect, test } from 'claude-code/testing'

import { addUsage, emptyTotals, formatRow, formatTokens, withCost } from '../hooks/logic'

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

test('tokens read in Spanish short units', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(18_400)).toBe('18,4 k')
  expect(formatTokens(1_240_000)).toBe('1,24 M')
})

test('a count just under a million rounds into millions', () => {
  expect(formatTokens(999_949)).toBe('999,9 k')
  expect(formatTokens(999_960)).toBe('1,00 M')
})

test('an empty session shows zero and no last call', () => {
  expect(formatRow(emptyTotals())).toBe('Sesión: 0 tokens (0 de caché)')
})

test('a response adds every token kind and becomes the last call', () => {
  const t = addUsage(addUsage(emptyTotals(), usage(10, 20, 30, 40)), usage(1, 2, 3, 4))
  expect(t).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, calls: 2, lastCall: 10 })
})

test('a missing cost keeps the last one', () => {
  const t = withCost(withCost(emptyTotals(), { usd: 0.5 }), undefined)
  expect(t.cost).toEqual({ usd: 0.5 })
})
