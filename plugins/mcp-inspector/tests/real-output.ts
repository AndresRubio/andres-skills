// Captured from the real OpsDesk server (mcp-lab, packages/opsdesk-server) on 2026-10-30,
// called in memory with the official SDK client; the redacted text is gateway.redaction.redact
// applied to it. The errored texts wrap the server's words the way Claude Code does: the SDK
// words a JSON-RPC error `MCP error <code>: <message>`, and the tool runner puts
// `Error calling tool...: <message>` inside <tool_use_error>.

export const LIST_INCIDENTS = "{\n  \"incidents\": [\n    {\n      \"id\": \"INC-101\",\n      \"service\": \"api\",\n      \"title\": \"Elevated 5xx on /checkout\",\n      \"status\": \"open\",\n      \"description\": \"Reported by customer jane.doe@example.com: checkout fails intermittently.\"\n    },\n    {\n      \"id\": \"INC-102\",\n      \"service\": \"search\",\n      \"title\": \"Search cluster unreachable\",\n      \"status\": \"open\",\n      \"description\": \"All search nodes failing health checks since 09:12 UTC.\"\n    },\n    {\n      \"id\": \"INC-099\",\n      \"service\": \"payments\",\n      \"title\": \"Delayed payout batch\",\n      \"status\": \"resolved\",\n      \"description\": \"Batch delayed 40 minutes; contact ops-lead@example.com for details.\"\n    }\n  ]\n}"

export const LIST_INCIDENTS_REDACTED = "{\n  \"incidents\": [\n    {\n      \"id\": \"INC-101\",\n      \"service\": \"api\",\n      \"title\": \"Elevated 5xx on /checkout\",\n      \"status\": \"open\",\n      \"description\": \"Reported by customer [REDACTED:email]: checkout fails intermittently.\"\n    },\n    {\n      \"id\": \"INC-102\",\n      \"service\": \"search\",\n      \"title\": \"Search cluster unreachable\",\n      \"status\": \"open\",\n      \"description\": \"All search nodes failing health checks since 09:12 UTC.\"\n    },\n    {\n      \"id\": \"INC-099\",\n      \"service\": \"payments\",\n      \"title\": \"Delayed payout batch\",\n      \"status\": \"resolved\",\n      \"description\": \"Batch delayed 40 minutes; contact [REDACTED:email] for details.\"\n    }\n  ]\n}"

export const SERVICE_STATUS = "{\n  \"name\": \"search\",\n  \"state\": \"down\",\n  \"restarts\": 0\n}"

// The JSON-RPC error a client without form elicitation gets from restart_service.
export const ERROR_32021_OBJECT = "{\"code\":-32021,\"message\":\"Client did not declare the form elicitation capability required by resolver 'opsdesk.server:build_server.<locals>.confirm_restart'\",\"data\":{\"requiredCapabilities\":{\"elicitation\":{\"form\":{}}}}}"

export const ERROR_32021 = "<tool_use_error>Error calling tool (restart_service): MCP error -32021: Client did not declare the form elicitation capability required by resolver 'opsdesk.server:build_server.<locals>.confirm_restart'</tool_use_error>"

export const UNKNOWN_SERVICE = "<tool_use_error>Error calling tool: Error executing tool restart_service: Unknown service 'nope'. Known services: api, payments, search.</tool_use_error>"
