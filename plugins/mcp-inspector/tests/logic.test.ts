import { describe, expect, test } from 'claude-code/testing'

import {
  errorCode,
  findEmails,
  findPhones,
  fitCalls,
  formatDuration,
  headLines,
  isHostServer,
  outcomeOf,
  parseCommand,
  parseMcpTool,
  piiCount,
  piiText,
  resolvePath,
  shortInput,
  toJsonl,
} from '../hooks/logic'
import type { McpCall } from '../types'
import {
  ERROR_32021,
  ERROR_32021_OBJECT,
  LIST_INCIDENTS,
  LIST_INCIDENTS_REDACTED,
  SERVICE_STATUS,
  UNKNOWN_SERVICE,
} from './real-output'

describe('real OpsDesk output', () => {
  test('the unredacted incident list holds two addresses and no phone', async () => {
    expect(findEmails(LIST_INCIDENTS)).toEqual(['jane.doe@example.com', 'ops-lead@example.com'])
    expect(findPhones(LIST_INCIDENTS)).toEqual([])
  })

  test('after the gateway redacts it, nothing is flagged', async () => {
    expect(piiCount(LIST_INCIDENTS_REDACTED)).toBeUndefined()
    expect(piiCount(SERVICE_STATUS)).toBeUndefined()
  })

  test('restart_service without form elicitation reads as -32021', async () => {
    expect(outcomeOf({ isError: true, text: ERROR_32021, result: ERROR_32021 })).toEqual({
      status: 'error',
      text: ERROR_32021,
      code: -32021,
    })
    expect(errorCode(ERROR_32021_OBJECT)).toBe(-32021)
    // A tool error the server answered has no JSON-RPC code.
    expect(outcomeOf({ isError: true, text: UNKNOWN_SERVICE }).code).toBeUndefined()
  })

  test('the head shows data, not the first brace of pretty JSON', async () => {
    expect(headLines(LIST_INCIDENTS, 2)).toHaveLength(1)
    expect(headLines(LIST_INCIDENTS, 2)[0]).toMatch(/^\{"incidents":\[\{"id":"INC-101","service":"api"/)
    expect(headLines(ERROR_32021, 2)).toEqual([
      "Error calling tool (restart_service): MCP error -32021: Client did not declare the form elicitation capability required by resolver 'opsdesk.server:build_server.<locals>.confirm_restart'",
    ])
  })
})

describe('emails', () => {
  test('finds the addresses the gateway redacts', async () => {
    expect(findEmails('Reported by customer jane.doe@example.com: checkout fails intermittently.')).toEqual([
      'jane.doe@example.com',
    ])
    expect(findEmails('{"service":"api","primary":"dana.lee@example.com","secondary":"sam.ortiz@example.com"}')).toEqual([
      'dana.lee@example.com',
      'sam.ortiz@example.com',
    ])
    expect(findEmails('page Dana.Lee+oncall@sub.example.co.uk now')).toEqual(['dana.lee+oncall@sub.example.co.uk'])
    expect(findEmails('<a href="mailto:ops-lead@example.com">')).toEqual(['ops-lead@example.com'])
    expect(findEmails('contacto: José.Núñez@ejemplo.es')).toEqual(['josé.núñez@ejemplo.es'])
    // The same address twice is one address.
    expect(findEmails('a@example.com, A@example.com')).toEqual(['a@example.com'])
  })

  test('leaves alone what only looks like one', async () => {
    for (const text of [
      'lodash@4.17.21',
      'pip install mcp@2.3.0',
      '{"primary":"[REDACTED:email]"}',
      'npm i @types/node',
      'ssh user@localhost',
      'image@sha256:9f86d081884c7d65',
      'ping @alice in #ops',
      'jane@example.c0m',
    ]) {
      expect(findEmails(text), text).toEqual([])
    }
  })
})

describe('phones', () => {
  test('finds numbers in the usual shapes', async () => {
    for (const text of [
      'call +1 415 555 0132 now',
      '+1-415-555-0132',
      '{"phone":"+14155550132"}',
      'London desk +44 20 7946 0958',
      'móvil +34 612 345 678',
      '+33 6 12 34 56 78',
      'primary: +1 (415) 555-0132',
      'office (415) 555-0132',
      'office 415-555-0132.',
      'office 415.555.0132',
      'toll free 1-800-555-0199',
      'phone: 612 345 678',
      '{"phoneNumber": "0612345678"}',
      'Tel. 020 7946 0958',
      '<a href="tel:+33612345678">',
      'mobile=06 12 34 56 78',
      'whatsapp: +49 30 1234567',
    ]) {
      expect(findPhones(text), text).toHaveLength(1)
    }
  })

  test('counts each number once', async () => {
    expect(findPhones('phone: +1 415-555-0132')).toEqual(['+14155550132'])
    expect(findPhones('+1 415 555 0132 or (212) 555-0199')).toHaveLength(2)
  })

  test('versions, timestamps, IDs, IPs and codes are not phones', async () => {
    for (const text of [
      // versions
      '1.2.3',
      'claude-code v2.1.309',
      'mcp 2.3.0 and fastmcp 4.1.0',
      'Python 3.12.4',
      'MCP spec 2026-07-28',
      'release 2026.07.28',
      'build 1.0.0+20130313144700',
      'macOS 10.15.7.1234',
      // timestamps
      '2026-10-30T12:34:56.789Z',
      '2026-10-30T12:34:56+05:30',
      '2026-10-30 12:34:56',
      'failing health checks since 09:12 UTC',
      'payout window (00:00-02:00 UTC)',
      'epoch 1730284800 or 1730284800123 ms',
      'UTC+05:30',
      'offset +05:30',
      // IDs
      'INC-101',
      'INC-415-555-0132',
      '550e8400-e29b-41d4-a716-446655440000',
      'req_01HZX3K9Q8 order 1234567890123',
      'order 123-45-6789',
      'commit 3f2a9c1',
      // IPs and ports
      '192.168.100.200',
      'http://10.0.0.1:8080/mcp',
      '127.0.0.1',
      '::1 and 2001:db8::ff00:42:8329',
      '255.255.255.0',
      // other numbers
      'MCP error -32021: Missing required client capability',
      'sizes 512 256 1024',
      'coverage +12.5%',
      '1,234,567 rows',
      'ids 100-200-3000',
      'took 1234 ms, restarts: 1',
      'iPhone 15 Pro 128 GB',
      'telemetry: 12345678',
      'phone: 2026-10-30',
    ]) {
      expect(findPhones(text), text).toEqual([])
    }
  })

  test('piiCount adds both kinds, or says nothing', async () => {
    expect(piiCount('dana.lee@example.com, +1 415 555 0132')).toEqual({ emails: 1, phones: 1 })
    expect(piiCount('{"primary":"[REDACTED:email]","since":"2026-10-30T09:12:00Z"}')).toBeUndefined()
  })

  test('piiText reads the text, a refusal and the structured record', async () => {
    expect(piiText({ text: 'ok', result: { contact: 'x@example.com' } })).toBe('ok\n{"contact":"x@example.com"}')
    expect(piiText({ text: 'same', result: 'same' })).toBe('same')
    expect(piiText({ deny: 'no' })).toBe('no')
  })
})

describe('error codes', () => {
  test('reads the JSON-RPC code of an errored call', async () => {
    expect(errorCode('MCP error -32021: Missing required client capability: elicitation')).toBe(-32021)
    expect(errorCode('Error: MCP error -32602: Unknown incident \'INC-9\'.')).toBe(-32602)
    expect(errorCode('{"jsonrpc":"2.0","id":3,"error":{"code":-32021,"message":"Missing required client capability"}}')).toBe(-32021)
    expect(errorCode('JSON-RPC error -32601 (method not found)')).toBe(-32601)
  })

  test('finds none where there is none', async () => {
    expect(errorCode("Unknown tool: 'run_diagnostics'")).toBeUndefined()
    expect(errorCode('took 32021 ms')).toBeUndefined()
    expect(errorCode('lines 12-32021')).toBeUndefined()
    expect(errorCode('code -31999')).toBeUndefined()
    expect(errorCode('HTTP 500 from http://127.0.0.1:8100/pages')).toBeUndefined()
  })

  test('outcomeOf sorts results into ok and error', async () => {
    expect(outcomeOf({ text: 'fine', result: 'fine' })).toEqual({ status: 'ok', text: 'fine' })
    expect(outcomeOf({ isError: true, text: 'MCP error -32021: no elicitation' })).toEqual({
      status: 'error',
      text: 'MCP error -32021: no elicitation',
      code: -32021,
    })
    expect(outcomeOf({ deny: 'Blocked by policy' })).toEqual({ status: 'error', text: 'Blocked by policy' })
    expect(outcomeOf({ result: [{ type: 'text', text: 'hi' }] })).toEqual({
      status: 'ok',
      text: '[{"type":"text","text":"hi"}]',
    })
  })
})

describe('names and inputs', () => {
  test('parseMcpTool splits server and tool', async () => {
    expect(parseMcpTool('mcp__opsdesk__list_incidents')).toEqual({ server: 'opsdesk', tool: 'list_incidents' })
    expect(parseMcpTool('mcp__claude-in-chrome__computer')).toEqual({ server: 'claude-in-chrome', tool: 'computer' })
    expect(parseMcpTool('mcp__plugin_lab_gateway__oncall_for')).toEqual({
      server: 'plugin_lab_gateway',
      tool: 'oncall_for',
    })
    expect(parseMcpTool('Bash')).toBeUndefined()
    expect(parseMcpTool('mcp__broken')).toBeUndefined()
    expect(parseMcpTool('mcp____x')).toBeUndefined()
    expect(parseMcpTool('mcp__x__')).toBeUndefined()
  })

  test('the desktop host servers are left out', async () => {
    expect(isHostServer('ccd_session')).toBe(true)
    expect(isHostServer('opsdesk')).toBe(false)
  })

  test('shortInput keeps the arguments on one short line', async () => {
    expect(
      shortInput({ tool: 'mcp__a__b', tool_use_id: 't1', service: 'search', limit: 5, filter: { status: 'open' } }),
    ).toBe('service=search limit=5 filter={"status":"open"}')
    expect(shortInput({ markdown: '# runbook\n\n1. Check node health.\n2. Restart the cluster.' })).toBe(
      'markdown=# runbook 1. Check node health. 2. Rest…',
    )
    expect(shortInput({})).toBe('')
  })

  test('headLines keeps the first non-empty lines', async () => {
    expect(headLines('\n{"a":1}\n\nsecond\nthird', 2)).toEqual(['{"a":1}', 'second'])
    expect(headLines('', 2)).toEqual([])
  })

  test('formatDuration', async () => {
    expect(formatDuration(350)).toBe('350 ms')
    expect(formatDuration(1400)).toBe('1.4 s')
    expect(formatDuration(125_000)).toBe('2m 5s')
  })
})

const call = (n: number, head = 1): McpCall => ({
  id: `t${n}`,
  server: 'opsdesk',
  tool: `tool_${n}`,
  input: '',
  startedAt: n,
  durationMs: 1,
  status: 'ok',
  head: Array.from({ length: head }, (_, i) => `line ${i}`),
})

describe('fitCalls', () => {
  test('keeps the newest calls that fit, oldest first', async () => {
    const list = Array.from({ length: 10 }, (_, i) => call(i))
    const { shown, hidden } = fitCalls(list, 7)
    expect(shown.map(one => one.id)).toEqual(['t7', 't8', 't9'])
    expect(hidden).toBe(7)
  })

  test('always shows the newest call, even when it is too tall', async () => {
    const { shown, hidden } = fitCalls([call(1), call(2, 5)], 2)
    expect(shown.map(one => one.id)).toEqual(['t2'])
    expect(hidden).toBe(1)
  })

  test('a flagged call takes one more row', async () => {
    const flagged = { ...call(2), pii: { emails: 1, phones: 0 } }
    expect(fitCalls([call(1), flagged], 4).shown).toHaveLength(1)
    expect(fitCalls([call(1), flagged], 5).shown).toHaveLength(2)
  })
})

describe('the command and the export', () => {
  test('parseCommand', async () => {
    expect(parseCommand('')).toEqual({ kind: 'open' })
    expect(parseCommand('  clear ')).toEqual({ kind: 'clear' })
    expect(parseCommand('export m3/log.jsonl')).toEqual({ kind: 'export', path: 'm3/log.jsonl' })
    expect(parseCommand('export "/tmp/a b.jsonl"')).toEqual({ kind: 'export', path: '/tmp/a b.jsonl' })
    expect(parseCommand('export')).toEqual({ kind: 'usage', reason: 'export needs a path.' })
    expect(parseCommand('clear all').kind).toBe('usage')
    expect(parseCommand('bogus').kind).toBe('usage')
  })

  test('resolvePath', async () => {
    expect(resolvePath('m3/log.jsonl', '/work/mcp-lab', undefined)).toBe('/work/mcp-lab/m3/log.jsonl')
    expect(resolvePath('./log.jsonl', '/work/mcp-lab/', undefined)).toBe('/work/mcp-lab/log.jsonl')
    expect(resolvePath('/tmp/log.jsonl', '/work/mcp-lab', undefined)).toBe('/tmp/log.jsonl')
    expect(resolvePath('~/evals/m3.jsonl', '/work', '/Users/me')).toBe('/Users/me/evals/m3.jsonl')
    expect(resolvePath('~/x', '/work', undefined)).toBeUndefined()
    expect(resolvePath('~', '/work', '/Users/me')).toBeUndefined()
  })

  test('toJsonl writes prompt, tools and at, one object per line', async () => {
    const text = toJsonl([
      { id: '1', prompt: 'which services are down?', tools: ['mcp__opsdesk__list_incidents'], at: '2026-10-30T09:00:00.000Z' },
      { id: '2', prompt: 'say "hi"\nthen stop', tools: [], at: '2026-10-30T09:01:00.000Z' },
    ])
    expect(text).toBe(
      '{"prompt":"which services are down?","tools":["mcp__opsdesk__list_incidents"],"at":"2026-10-30T09:00:00.000Z"}\n' +
        '{"prompt":"say \\"hi\\"\\nthen stop","tools":[],"at":"2026-10-30T09:01:00.000Z"}\n',
    )
    expect(toJsonl([])).toBe('')
  })
})
