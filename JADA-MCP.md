# Chat-driven MCP connections

MCP setup is initiated in the copilot conversation. No server or tools are preinstalled into a user's workflow.

## User flow

1. Paste `add MCP https://your-server.example/mcp` followed by `Bearer YOUR_TOKEN` in the same composer and press Enter. The composer splits the credential into a dedicated connection request; it is not submitted as model chat text.
2. Exact add/connect/attach URL commands use a deterministic connection path in the copilot service, without waiting for a model to infer a settings workflow.
3. Authenticated tools are discovered in that single submission. URL-only requests are also supported; if authentication is required, an inline password field remains available as an optional alternative.
4. Once connected, ask the copilot to add the appropriate discovered tools to a named Agent. The copilot has `mcp_list` and paginated `mcp_tools` capabilities and uses native revision-pinned `flow_edit` operations.
5. Start a test run and review individual tool-call approvals in the native run panel.

Connecting discovers a tool catalog; it does not run tools or attach them to an Agent automatically. Credentials never enter graph fields or model prompts.

## Implementation

- Uses the MCP SDK's Streamable HTTP client with initialize/initialized, protocol negotiation, session handling, paginated tools/list, and tools/call.
- Connections are scoped to a workflow behind native user authorization. The connector adapter exposes real action schemas and connection IDs to native Agent authoring.
- Bearer tokens are encrypted using AES-256-GCM with the connection ID as additional authenticated data. The deployment key is generated beside the SQLite database with mode 0600. Back up the database and key securely together; never commit either.
- Native Agent declarations must have `approval:true` for MCP tools. Misconfigured declarations fail before model execution. Direct Code/Connector calls cannot bypass the approval-gated Agent path.
- Tool calls are not automatically retried after an ambiguous failure.
- Existing known credential patterns in old conversation displays and model history are redacted. This is not a claim that previously stored secrets were securely erased from database backups or prior screenshots.

## Supported boundaries

Public HTTPS Streamable HTTP endpoints on standard port 443, anonymous or bearer authentication, are supported. URLs with embedded credentials, query parameters, redirects, IP literals or private/local networks are rejected. DNS is checked and the selected public IPv4 address is pinned for the request.

OAuth, stdio process launching, legacy SSE-only endpoints, custom authentication header schemes, private-network endpoints, and IPv6-only servers are not implemented. Servers must expose compatible JSON tool schemas. Limits are ten connections per workflow, 500 tools per connection and an 8 MiB response budget.

## Verification

- Eleven MCP-focused tests cover public/private network guards, tool discovery, encrypted credentials, restart decryption, workflow isolation, approval-path enforcement, non-retry behavior, native Agent graph authoring, secret redaction and direct URL-plus-token submission.
- A real local JSON-RPC fixture exercises SDK initialization, initialized notification, two-page tool discovery and a tool call. It uses only synthetic credentials and has no external integrations.
- Three real Pipali runtime tests cover ordinary tool approvals, MCP-prefixed tools with approval/restart/rejection, and rejection of an MCP declaration that omits approval before any provider call.
- The copilot and database-migration suites pass with the new migration.
- Browser tests verify single-Enter URL-plus-token submission to the dedicated endpoint without a chat message or blocking alert. They also cover the optional password card, secure-endpoint submission, mobile layout and the absence of the misleading MCP Settings button.

No user MCP server was connected or called during this implementation. Live compatibility with a particular external server is established only when the user chooses to connect it.
