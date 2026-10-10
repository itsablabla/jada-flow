import type { runPipali } from '../node/deployment/pipali-client.ts'
import type { PipaliBatch } from '../node/deployment/pipali-contract.ts'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { CopilotService } from '../node/application/copilot-service.ts'
import { createLlm } from '../node/deployment/llm.ts'
import { CopilotStore } from '../node/storage/copilot-store.ts'
import { Database } from '../node/storage/database.ts'
import { closeService, openService } from './serviceFixture.ts'

async function setup(engine: typeof runPipali) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jada-copilot-test-'))
  const file = path.join(directory, 'test.sqlite')
  const service = await openService(file)
  const database = Database.open(file)
  const store = new CopilotStore(database.connection)
  const copilot = new CopilotService(store, service.control, () => createLlm('http://127.0.0.1:1', 'fixture'), engine)
  const { flow } = await service.control.createFlow('operator', 'Copilot fixture', 'create')
  onTestFinished(async () => {
    copilot.close()
    await closeService(service)
    database.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { service, database, store, copilot, flow }
}

const noTools: typeof runPipali = async (request) => ({ text: 'Nothing changed.', rounds: 1, history: request.history })

function batch(request: Parameters<typeof runPipali>[0], name: string, args: Record<string, never> | object): PipaliBatch {
  return {
    rounds: 1,
    history: request.history,
    step: {
      step_id: 2,
      timestamp: new Date().toISOString(),
      source: 'agent',
      tool_calls: [{ tool_call_id: 'call', function_name: name, arguments: args as never }],
    },
  }
}

it('uses native atomic authoring and saves an executable graph revision', async () => {
  const f = await setup(async (request, host) => {
    expect(request.tools.some((tool) => tool.name === 'flow_run' || tool.name === 'flow_publish')).toBe(false)
    const id = f.flow.flowId
    const read = await host.dispatch(batch(request, 'flow_read', { flowId: id }))
    const revision = JSON.parse(read[0]!.content).revision
    const edited = await host.dispatch(
      batch(request, 'flow_edit', {
        flowId: id,
        baseRevision: revision,
        requestId: 'edit-fixture',
        edits: [
          { op: 'node.add', as: 'start', type: 'manual', name: 'Start' },
          {
            op: 'node.add',
            as: 'code',
            type: 'code',
            name: 'Calculate',
            code: 'export default function() { return {total:42} }',
            config: { outputs: { total: { schema: { type: 'number' }, nullable: false } } },
          },
          { op: 'edge.connect', source: '$start', target: '$code' },
        ],
      }),
    )
    const result = JSON.parse(edited[0]!.content)
    expect(result.saved).toBe(true)
    expect(result.validation.status).toBe('valid')
    return { text: 'Created and validated. Not executed.', rounds: 2, history: request.history }
  })
  f.copilot.start('operator', f.flow.flowId, 'r1', 'Create a calculation.')
  await expect.poll(() => f.copilot.read('operator', f.flow.flowId).turns[0]?.status).toBe('completed')
  expect(f.service.control.getFlow(f.flow.flowId).draftRevisionId).not.toBe(f.flow.draftRevisionId)
})

it('deduplicates repeated turn IDs and rejects different content under the same ID', async () => {
  const f = await setup(noTools)
  const first = f.copilot.start('operator', f.flow.flowId, 'r1', 'Inspect.')
  expect(f.copilot.start('operator', f.flow.flowId, 'r1', 'Inspect.').turnId).toBe(first.turnId)
  expect(() => f.copilot.start('operator', f.flow.flowId, 'r1', 'Different.')).toThrow('different content')
  await expect.poll(() => f.copilot.read('operator', f.flow.flowId).turns[0]?.status).not.toBe('running')
})

it('denies foreign users before any model execution', async () => {
  const f = await setup(noTools)
  expect(() => f.copilot.start('another-user', f.flow.flowId, 'r1', 'Inspect.')).toThrow()
  expect(() => f.copilot.read('another-user', f.flow.flowId)).toThrow()
})

it('persists a question before presenting it and does not run later tools', async () => {
  const f = await setup(async (request, host) => {
    await host.dispatch(batch(request, 'ask_user', { question: 'Which account should this use? Open Settings to connect it.' }))
    throw new Error('A question must stop the turn.')
  })
  f.copilot.start('operator', f.flow.flowId, 'r1', 'Connect account.')
  await expect.poll(() => f.copilot.read('operator', f.flow.flowId).turns[0]?.status).toBe('needs-input')
  expect(f.store.list('operator', f.flow.flowId)[0]?.question).toContain('Which account')
})

it('stops before mutation and retains the existing graph', async () => {
  const f = await setup(async (_request, _host, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    signal.throwIfAborted()
    throw new Error('Unreachable.')
  })
  f.copilot.start('operator', f.flow.flowId, 'r1', 'Wait.')
  expect(f.copilot.stop('operator', f.flow.flowId)).toBe(true)
  await expect.poll(() => f.copilot.read('operator', f.flow.flowId).turns[0]?.status).toBe('canceled')
  expect(f.service.control.getFlow(f.flow.flowId).draftRevisionId).toBe(f.flow.draftRevisionId)
})

it('keeps request secret patterns out of conversation persistence', async () => {
  const f = await setup(noTools)
  expect(() => f.copilot.start('operator', f.flow.flowId, 'r1', `my key: mnfst_${'x'.repeat(32)}`)).toThrow('secure credential field')
  expect(f.store.list('operator', f.flow.flowId)).toEqual([])
})
