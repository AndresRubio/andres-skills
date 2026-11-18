import type { ModelUsage, SessionCost } from 'claude-code'

import type { Totals } from '../types'

export const emptyTotals = (): Totals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  calls: 0,
  lastCall: 0,
})

/** The tokens that went through the prompt cache, read or written. */
export const cacheTokens = (t: Totals): number => t.cacheRead + t.cacheWrite

/** Every token kind together: input, output, cache read and cache write. */
export const totalTokens = (t: Totals): number => t.input + t.output + cacheTokens(t)

/** Adds one model response to the running totals. */
export const addUsage = (t: Totals, u: ModelUsage): Totals => {
  const sums = {
    ...t,
    input: t.input + u.input_tokens,
    output: t.output + u.output_tokens,
    cacheRead: t.cacheRead + u.cache_read_input_tokens,
    cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
    calls: t.calls + 1,
  }
  return { ...sums, lastCall: totalTokens(sums) - totalTokens(t) }
}

/** Takes the engine's cost estimate; keeps the old one when there is none. */
export const withCost = (t: Totals, cost: SessionCost | undefined): Totals =>
  cost === undefined ? t : { ...t, cost }

const decimal = (n: number, digits: number): string => n.toFixed(digits).replace('.', ',')

/** 950, 18,4 k, 1,24 M: Spanish decimal comma, short units. */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  // Round before picking the unit, so 999 960 reads 1,00 M and never 1000,0 k.
  const thousands = Math.round(n / 100) / 10
  if (thousands < 1000) return `${decimal(thousands, 1)} k`
  return `${decimal(n / 1_000_000, 2)} M`
}

export const formatUsd = (usd: number): string => `~${decimal(usd, 2)} $`

/** The band's one line. */
export const formatRow = (t: Totals): string => {
  const parts = [`Sesión: ${formatTokens(totalTokens(t))} tokens (${formatTokens(cacheTokens(t))} de caché)`]
  if (t.cost !== undefined) parts.push(formatUsd(t.cost.usd))
  if (t.calls > 0) parts.push(`última llamada +${formatTokens(t.lastCall)}`)
  return parts.join(' · ')
}
