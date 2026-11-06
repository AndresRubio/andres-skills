// Personal data found in one result: how many of each kind.
export type PiiCount = { emails: number; phones: number }

// One MCP tool call as the pane shows it.
export type McpCall = {
  // The call's tool_use_id.
  id: string
  server: string
  tool: string
  // A short form of the arguments.
  input: string
  startedAt: number
  durationMs?: number
  status: 'running' | 'ok' | 'error'
  // The JSON-RPC error code of an errored call, when the text names one.
  code?: number
  // The first lines of the result (or of the error).
  head: string[]
  pii?: PiiCount
  // Set when a subagent made the call.
  agentId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'mcp-inspector': {
      calls: Shaped<McpCall[]>
      // Id of the selection-log entry the current prompt writes to; '' for none.
      turn: string
      // True once the pane opened by itself in this session.
      autoOpened: boolean
    }
  }
}
