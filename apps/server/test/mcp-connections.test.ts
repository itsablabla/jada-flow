import type { ConnectorAccessContext } from '../node/deployment/connector.ts'
import type { McpRemote } from '../node/deployment/mcp-transport.ts'

import { once } from 'node:events'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { parseMcpConnectionMessage, redactChatSecrets } from '../common/chat-secrets.ts'
import { CopilotService } from '../node/application/copilot-service.ts'
import { createLlm } from '../node/deployment/llm.ts'
import { McpConnections } from '../node/deployment/mcp-connections.ts'
import { withMcpConnections } from '../node/deployment/mcp-connector.ts'
import { createMcpRemote, publicMcpAddress, publicMcpUrl } from '../node/deployment/mcp-transport.ts'
import { CopilotStore } from '../node/storage/copilot-store.ts'
import { Database } from '../node/storage/database.ts'
import { closeService, openService } from './serviceFixture.ts'

const tools = [
  { name: 'echo', description: 'Echo fixture only', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
]
async function fixture(remote: McpRemote) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jada-mcp-'))
  const file = path.join(directory, 'test.sqlite')
  const service = await openService(file, { capabilities: { llm: () => createLlm('http://127.0.0.1:1', 'fixture') } })
  const db = Database.open(file)
  const mcp = new McpConnections(db.connection, remote)
  const { flow } = await service.control.createFlow('operator', 'MCP fixture', 'fixture')
  onTestFinished(async () => {
    await closeService(service)
    db.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, file, service, db, mcp, flow }
}

it('rejects private-network URLs and IP targets before connection', () => {
  for (const url of [
    'http://example.com/mcp',
    'https://127.0.0.1/mcp',
    'https://localhost/mcp',
    'https://a.local/mcp',
    'https://user:pass@example.com/mcp',
    'https://example.com/mcp?key=secret',
    'https://example.com:444/mcp',
  ])
    expect(() => publicMcpUrl(url)).toThrow()
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.100.100.200', '::1', '::ffff:127.0.0.1'])
    expect(publicMcpAddress(address)).toBe(false)
  expect(publicMcpAddress('1.1.1.1')).toBe(true)
})

it('discovers public tools without executing them and scopes catalogs by flow', async () => {
  const calls: string[] = []
  const f = await fixture(async (_url, _token, method) => {
    calls.push(method)
    return tools
  })
  const result = await f.mcp.connect(f.flow.flowId, 'https://fixture.example/mcp')
  expect(result.status).toBe('active')
  expect(result.toolCount).toBe(1)
  expect(calls).toEqual(['list'])
  expect(f.mcp.actions('another-flow')).toEqual([])
  expect(f.mcp.actions(f.flow.flowId)[0]?.actionId).toBe(`${result.connectionId}.echo`)
  await f.mcp.connect(f.flow.flowId, 'https://fixture.example/mcp')
  expect(f.mcp.list(f.flow.flowId)).toHaveLength(1)
})

it('stores credentials encrypted, never returns them, and retains them across manager restart', async () => {
  const seen: (string | undefined)[] = []
  const remote: McpRemote = async (_url, token, method) => {
    seen.push(token)
    if (token !== 'synthetic-fixture-token') throw new Error('401')
    return method === 'list' ? tools : { content: [{ type: 'text', text: 'fixture success' }] }
  }
  const f = await fixture(remote)
  const pending = await f.mcp.connect(f.flow.flowId, 'https://fixture.example/mcp')
  expect(pending.status).toBe('needs-auth')
  await f.mcp.authorize(f.flow.flowId, pending.connectionId, 'synthetic-fixture-token')
  const row = f.mcp.rows(f.flow.flowId)[0]!
  expect(row.encrypted_token).not.toContain('synthetic')
  expect(JSON.stringify(f.mcp.list(f.flow.flowId))).not.toContain('synthetic-fixture-token')
  expect((await stat(`${f.file}.mcp-key`)).mode & 0o777).toBe(0o600)
  expect((await readFile(`${f.file}.mcp-key`)).length).toBe(32)
  const restarted = new McpConnections(f.db.connection, remote)
  await restarted.execute(f.flow.flowId, pending.connectionId, `${pending.connectionId}.echo`, { text: 'hello' }, new AbortController().signal)
  expect(seen.at(-1)).toBe('synthetic-fixture-token')
  await expect(restarted.authorize('foreign', pending.connectionId, 'synthetic-fixture-token')).rejects.toThrow('not found')
})

it('refuses direct MCP execution without the Agent approval path and foreign flow access', async () => {
  const calls: string[] = []
  const f = await fixture(async (_url, _token, method) => {
    calls.push(method)
    return method === 'list' ? tools : { content: [] }
  })
  const c = await f.mcp.connect(f.flow.flowId, 'https://fixture.example/mcp')
  const host = withMcpConnections(f.mcp)
  const action = `${c.connectionId}.echo`
  const access = {
    flowId: f.flow.flowId,
    scope: 'action',
    action,
    connectionId: c.connectionId,
    purpose: 'execute',
    source: 'run',
    providerAccess: {},
  } as unknown as ConnectorAccessContext
  await expect(host.execute(action, c.connectionId, { text: 'hi' }, 'one', new AbortController().signal, access)).rejects.toThrow('approval')
  await host.execute(action, c.connectionId, { text: 'hi' }, 'one', new AbortController().signal, { ...access, mcpApproved: true })
  expect(calls).toEqual(['list', 'call'])
  await expect(host.getAction(action, undefined, { ...access, flowId: 'foreign' })).rejects.toThrow('not in this workflow')
})

it('does not retry ambiguous or error tool calls', async () => {
  let calls = 0
  const f = await fixture(async (_url, _token, method) => {
    if (method === 'list') return tools
    calls++
    return { isError: true, content: [{ type: 'text', text: 'sensitive upstream detail' }] }
  })
  const c = await f.mcp.connect(f.flow.flowId, 'https://fixture.example/mcp')
  await expect(f.mcp.execute(f.flow.flowId, c.connectionId, `${c.connectionId}.echo`, {}, new AbortController().signal)).rejects.toThrow(
    'may have taken effect',
  )
  expect(calls).toBe(1)
})

it('saves a native Agent with discovered MCP action schemas and the correct connection', async () => {
  const f = await fixture(async () => tools)
  const connection = await f.mcp.connect(f.flow.flowId, 'https://fixture.example/mcp')
  const result = await f.service.control.editAuthoring('operator', f.flow.flowId, {
    baseRevision: f.flow.draftRevisionId,
    requestId: 'bind-mcp-fixture',
    edits: [
      { op: 'node.add', as: 'start', type: 'manual', name: 'Start' },
      {
        op: 'node.add',
        as: 'agent',
        type: 'agent',
        name: 'MCP Agent',
        prompt: 'Echo hello with the declared tool.',
        config: {
          model: 'auto',
          maxRounds: 4,
          tools: [
            {
              name: 'echo',
              description: 'Echo fixture',
              action: `${connection.connectionId}.echo`,
              connectionId: connection.connectionId,
              approval: true,
              inputs: { text: { kind: 'model' } },
            },
          ],
        },
      },
      { op: 'edge.connect', source: '$start', target: '$agent' },
    ],
  })
  expect(result.saved).toBe(true)
  expect(result.validation.status, JSON.stringify(result.validation)).toBe('valid')
  const action = await f.service.control.getConnectorAction(`${connection.connectionId}.echo`, f.flow.flowId, undefined, undefined, 'operator')
  expect(action.actionId).toBe(`${connection.connectionId}.echo`)
})

it('chat connection request pauses for secure credentials without persisting them in the conversation', async () => {
  const f = await fixture(async () => {
    throw new Error('Unauthorized')
  })
  const store = new CopilotStore(f.db.connection)
  const copilot = new CopilotService(
    store,
    f.service.control,
    () => createLlm('http://127.0.0.1:1', 'fixture'),
    async (request, host) => {
      expect(request.tools.some((tool) => tool.name === 'mcp_connect')).toBe(true)
      await host.dispatch({
        rounds: 1,
        history: request.history,
        step: {
          step_id: 2,
          timestamp: new Date().toISOString(),
          source: 'agent',
          tool_calls: [{ tool_call_id: 'call', function_name: 'mcp_connect', arguments: { url: 'https://fixture.example/mcp' } }],
        },
      })
      throw new Error('Must pause before continuing')
    },
    f.mcp,
  )
  copilot.start('operator', f.flow.flowId, 'connect', 'add MCP https://fixture.example/mcp')
  await expect.poll(() => copilot.read('operator', f.flow.flowId).turns[0]?.status).toBe('needs-input')
  expect(copilot.read('operator', f.flow.flowId).mcpConnections).toHaveLength(1)
  expect(() => copilot.start('operator', f.flow.flowId, 'secret', 'Bearer synthetic-fixture-token')).toThrow('secure credential field')
  expect(() => copilot.read('foreign', f.flow.flowId)).toThrow()
  copilot.close()
})

it('redacts bearer and underscore-prefixed keys in legacy transcript text', () => {
  expect(redactChatSecrets('Bearer\nsynthetic-fixture-token')).toBe('Bearer [redacted]')
  expect(redactChatSecrets('sk_' + 'a'.repeat(32))).toBe('[redacted credential]')
  expect(redactChatSecrets('add mcp https://fixture.example/mcp')).toBe('add mcp https://fixture.example/mcp')
})

it('parses an explicit URL and bearer credential in one composer submission', () => {
  for (const input of [
    'add mcp https://fixture.example/mcp\nBearer synthetic-fixture-token',
    'add https://fixture.example/mcp Authorization: Bearer synthetic-fixture-token',
    'Connect MCP server https://fixture.example/mcp\nbearer synthetic-fixture-token',
  ])
    expect(parseMcpConnectionMessage(input)).toEqual({ url: 'https://fixture.example/mcp', token: 'synthetic-fixture-token' })
  for (const input of [
    'add mcp https://fixture.example/mcp Bearer [redacted]',
    'do not add https://fixture.example/mcp Bearer synthetic-fixture-token',
    'Bearer synthetic-fixture-token',
  ])
    expect(parseMcpConnectionMessage(input)).toBeUndefined()
})

it('connects directly without a second prompt, model call, or plaintext transcript credential', async () => {
  let discoveryCalls = 0
  const f = await fixture(async (_url, token, method) => {
    expect(token).toBe('synthetic-direct-token')
    expect(method).toBe('list')
    discoveryCalls++
    return tools
  })
  const store = new CopilotStore(f.db.connection)
  const copilot = new CopilotService(
    store,
    f.service.control,
    () => undefined,
    async () => {
      throw new Error('Model must not receive connection credentials')
    },
    f.mcp,
  )
  const result = await copilot.connectMcpDirect('operator', f.flow.flowId, 'direct', 'https://fixture.example/mcp', 'synthetic-direct-token')
  expect(result.status).toBe('completed')
  expect(discoveryCalls).toBe(1)
  expect(JSON.stringify(store.list('operator', f.flow.flowId))).not.toContain('synthetic-direct-token')
  expect(JSON.stringify(copilot.read('operator', f.flow.flowId))).not.toContain('synthetic-direct-token')
  expect(f.mcp.rows(f.flow.flowId)[0]?.encrypted_token).not.toContain('synthetic-direct-token')
  expect((await copilot.connectMcpDirect('operator', f.flow.flowId, 'direct', 'https://fixture.example/mcp', 'synthetic-direct-token')).status).toBe(
    'completed',
  )
  expect(discoveryCalls).toBe(1)
  await expect(copilot.connectMcpDirect('foreign', f.flow.flowId, 'foreign', 'https://fixture.example/mcp', 'synthetic-direct-token')).rejects.toThrow()
  expect(discoveryCalls).toBe(1)
  expect(f.service.control.getFlow(f.flow.flowId).draftRevisionId).toBe(f.flow.draftRevisionId)
  copilot.close()
})

it('uses a real MCP initialize, notification, paginated tools/list and tools/call handshake', async () => {
  const methods: string[] = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(204)
      res.end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const rpc = JSON.parse(body)
    methods.push(rpc.method)
    expect(req.headers.authorization).toBe('Bearer fixture-only')
    if (!('id' in rpc)) {
      res.writeHead(202)
      res.end()
      return
    }
    let result
    if (rpc.method === 'initialize')
      result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    else if (rpc.method === 'tools/list') result = rpc.params?.cursor ? { tools: [{ ...tools[0], name: 'second' }] } : { tools, nextCursor: 'page2' }
    else result = { content: [{ type: 'text', text: rpc.params.arguments.text }] }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture port missing')
  const remote = createMcpRemote(async (_url, init) => fetch(`http://127.0.0.1:${address.port}/mcp`, init))
  const listed = (await remote('https://fixture.example/mcp', 'fixture-only', 'list')) as unknown[]
  expect(listed).toHaveLength(2)
  const called = await remote('https://fixture.example/mcp', 'fixture-only', 'call', { name: 'echo', arguments: { text: 'hello' } })
  expect(called).toEqual({ content: [{ type: 'text', text: 'hello' }] })
  expect(methods).toContain('notifications/initialized')
  expect(methods.filter((method) => method === 'tools/list')).toHaveLength(2)
})
