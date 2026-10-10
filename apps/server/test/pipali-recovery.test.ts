import type { JsonValue } from '@oomol-lab/open-flow/flow-change'

import { currentFlowModelVersion } from '@oomol-lab/open-flow/flow-change'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createLlm } from '../node/deployment/llm.ts'
import { createConnectorHost } from './connectorHost.ts'
import { acceptRun } from './runFixture.ts'
import { closeService, openService, startService } from './serviceFixture.ts'

it.skipIf(!process.env.JADA_PIPALI_SOURCE).each([
  { action: 'fixture.send', approval: true },
  { action: 'jada_mcp_fixture.send', approval: true },
  { action: 'jada_mcp_fixture.send', approval: false },
])(
  'real Pipali survives restart and approvals without repeated effects for $action (declared approval=$approval)',
  async ({ action, approval }) => {
    const requests: unknown[] = []
    const provider = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      const output =
        requests.length === 1
          ? [
              { type: 'function_call', id: 'fc_a', call_id: 'a', name: 'send', arguments: '{"body":"one"}', status: 'completed' },
              { type: 'function_call', id: 'fc_b', call_id: 'b', name: 'send', arguments: '{"body":"two"}', status: 'completed' },
            ]
          : [{ type: 'message', id: 'm1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] }]
      const base = { id: `r${requests.length}`, object: 'response', created_at: 1, model: 'fixture', error: null, incomplete_details: null, output: [] }
      const events = [
        { type: 'response.created', sequence_number: 0, response: { ...base, status: 'in_progress' } },
        {
          type: 'response.completed',
          sequence_number: 1,
          response: { ...base, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const llm = createLlm(`http://127.0.0.1:${address.port}`, 'synthetic-fixture')
    Object.assign(llm, { config: { ...llm.config, agentEngine: 'pipali' } })
    const effects: { callId: string; input: Readonly<Record<string, JsonValue>> }[] = []
    const connector = createConnectorHost({
      getAction: async () => ({
        actionId: action,
        authenticated: false,
        description: 'Fixture only.',
        serviceId: 'fixture',
        serviceName: 'Fixture',
        name: 'send',
        inputSchema: {},
        outputSchema: {},
        inputs: {},
        outputs: {},
      }),
      execute: async (_action, _connection, input, callId) => {
        effects.push({ callId, input })
        return { fixtureOnly: true }
      },
    })
    const directory = await mkdtemp(path.join(tmpdir(), 'jada-recovery-'))
    const file = path.join(directory, 'store.sqlite')
    const options = { capabilities: { llm: () => llm, connector: () => connector } }
    let service = await openService(file, options)
    try {
      await startService(service)
      const accepted = await acceptRun(service, {
        flowId: 'flow',
        idempotencyKey: 'pipali-recovery',
        revisionId: 'revision',
        revision: {
          modelVersion: currentFlowModelVersion,
          modules: {},
          document: {
            bindings: {},
            graph: {
              edges: [],
              nodes: {
                agent: {
                  kind: 'task',
                  name: 'Agent',
                  inputs: {},
                  task: {
                    name: 'Agent',
                    inputs: [],
                    outputs: [{ handle: 'output', jsonSchema: { type: 'string' }, nullable: false }],
                    executor: {
                      kind: 'agent',
                      model: 'fixture',
                      prompt: 'Send one and two using declared tools.',
                      maxRounds: 6,
                      tools: [
                        {
                          id: 'send',
                          name: 'send',
                          description: 'Fixture send',
                          action,
                          approval,
                          inputs: [{ handle: 'body', jsonSchema: { type: 'string' }, nullable: false, source: { kind: 'model' } }],
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      })
      if (accepted.kind !== 'accepted') throw new Error('Run not accepted.')
      if (!approval) {
        await expect.poll(() => service.control.runs.getRun(accepted.runId).status).toBe('failed')
        expect(effects).toEqual([])
        expect(requests).toEqual([])
        return
      }
      await expect.poll(() => service.control.runs.getRun(accepted.runId).waits.length, { timeout: 30000 }).toBe(1)
      expect(effects).toEqual([])
      await expect.poll(() => service.control.runs.getRun(accepted.runId).status).toBe('waiting')
      const firstWait = service.control.runs.getRun(accepted.runId).waits[0]!.waitId
      await closeService(service)
      service = await openService(file, options)
      await startService(service)
      expect(service.control.runs.getRun(accepted.runId).waits[0]!.waitId).toBe(firstWait)
      service.control.runs.resolveRunWait(accepted.runId, firstWait, 'approve')
      await expect.poll(() => service.control.runs.getRun(accepted.runId).waits[0]?.waitId, { timeout: 30000 }).not.toBe(firstWait)
      await expect.poll(() => service.control.runs.getRun(accepted.runId).waits.length).toBe(1)
      const secondWait = service.control.runs.getRun(accepted.runId).waits[0]!.waitId
      expect(effects).toHaveLength(1)
      expect(requests).toHaveLength(1)
      await expect.poll(() => service.control.runs.getRun(accepted.runId).status).toBe('waiting')
      await closeService(service)
      service = await openService(file, options)
      await startService(service)
      service.control.runs.resolveRunWait(accepted.runId, secondWait, 'reject')
      await expect.poll(() => service.control.runs.getRun(accepted.runId).status, { timeout: 30000 }).toBe('completed')
      expect(effects).toHaveLength(1)
      expect(effects[0]?.input).toEqual({ body: 'one' })
      expect(service.control.runs.listRunResults(accepted.runId).results).toHaveLength(1)
      expect(service.events(accepted.runId).filter((event) => event.kind === 'node.started')).toHaveLength(1)
      expect(requests).toHaveLength(2)
    } finally {
      await closeService(service)
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
  90000,
)
