import type { JsonValue, ManagedTaskDefinition } from '@oomol-lab/open-flow/flow-change'
import type { AgentInvocation, AgentResult } from '@oomol-lab/open-flow/runtime-contract'
import type { ResultHost } from '../node/deployment/agent-tools.ts'
import type { runPipali } from '../node/deployment/pipali-client.ts'
import type { PipaliCall } from '../node/deployment/pipali-contract.ts'

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { executePipaliAgent } from '../node/deployment/pipali-agent.ts'
import { pipaliFramework } from '../node/deployment/pipali-contract.ts'

const model = { origin: 'http://127.0.0.1:1/v1', token: 'synthetic-fixture', name: 'fixture' }
const task: ManagedTaskDefinition = {
  name: 'Review',
  inputs: [],
  outputs: [{ handle: 'output', nullable: false, jsonSchema: { type: 'string' } }],
  executor: {
    kind: 'agent',
    model: 'fixture',
    prompt: 'Perform only the requested action.',
    maxRounds: 6,
    tools: [
      {
        id: 'send',
        name: 'send',
        description: 'Send a fixture notification.',
        action: 'fixture.send',
        approval: true,
        inputs: [{ handle: 'body', nullable: false, jsonSchema: { type: 'string' }, source: { kind: 'model' } }],
      },
    ],
  },
}

function call(id: string, body: string, name = 'send'): PipaliCall {
  return { tool_call_id: id, function_name: name, arguments: { body } }
}

function scripted(batches: readonly (string | readonly PipaliCall[])[]): typeof runPipali {
  let index = 0
  return async (request, host, signal) => {
    let rounds = request.rounds
    const history = structuredClone(request.history)
    await host.event({ kind: 'engine', framework: pipaliFramework })
    while (index < batches.length) {
      signal.throwIfAborted()
      const next = batches[index++]!
      rounds++
      if (typeof next === 'string') return { text: next, rounds, history }
      const step = { step_id: history.steps.length + 1, timestamp: new Date().toISOString(), source: 'agent' as const, tool_calls: next }
      const observations = await host.dispatch({ history: structuredClone(history), step, rounds })
      history.steps.push({ ...step, observation: { results: observations } })
    }
    throw new Error('Fixture exhausted.')
  }
}

function fixture() {
  const values = new Map<string, NonNullable<ReturnType<ResultHost['get']>>>()
  const results: ResultHost = {
    find: (id) => values.get(id),
    get: (id) => values.get(id),
    save: (id, tool, _input, output) => {
      const content = JSON.stringify(output)
      const result = {
        resultId: id,
        callId: id,
        toolId: tool.id,
        source: { kind: 'code' as const },
        bytes: Buffer.byteLength(content),
        digest: createHash('sha256').update(content).digest('hex'),
        createdAt: new Date().toISOString(),
      }
      values.set(id, { result, content })
      return result
    },
  }
  const execute = vi.fn<Parameters<typeof executePipaliAgent>[3]>(async () => ({ fixtureOnly: true }))
  const report = vi.fn(async () => {})
  const compute = vi.fn(async () => 42 as JsonValue)
  const invocation: AgentInvocation = { invocationId: 'invocation-1', input: {}, signal: new AbortController().signal }
  const run = (engine: typeof runPipali, resume?: AgentInvocation['resume'], definition = task) =>
    executePipaliAgent(definition, { ...invocation, ...(resume ? { resume } : {}) }, model, execute, report, results, compute, engine)
  return { run, execute, report, values, invocation, results, compute }
}

function checkpoint(result: AgentResult) {
  if (result.kind !== 'suspended') throw new Error('Expected suspension.')
  return JSON.parse(JSON.stringify(result.checkpoint)) as typeof result.checkpoint
}

describe('Pipali Agent host parity', () => {
  it('returns output and reports the actual engine contract', async () => {
    const f = fixture()
    expect(await f.run(scripted(['complete']))).toEqual({ kind: 'completed', output: 'complete' })
    expect(f.report).toHaveBeenCalledWith({ kind: 'engine', framework: pipaliFramework })
  })

  it('suspends before dispatch and resumes the exact approved call', async () => {
    const f = fixture()
    const saved = checkpoint(await f.run(scripted([[call('a', 'hello')], 'unused'])))
    expect(f.execute).not.toHaveBeenCalled()
    expect(await f.run(scripted(['done']), { action: 'approve', checkpoint: saved })).toEqual({ kind: 'completed', output: 'done' })
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls[0]?.[1]).toEqual({ body: 'hello' })
  })

  it('keeps two approvals in one batch without requesting the model between them', async () => {
    const f = fixture()
    const first = checkpoint(await f.run(scripted([[call('a', 'one'), call('b', 'two')]])))
    const neverModel = vi.fn<typeof runPipali>(async () => {
      throw new Error('Must not ask the model yet.')
    })
    const second = checkpoint(await f.run(neverModel, { action: 'approve', checkpoint: first }))
    expect(neverModel).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(second.callId).toBe('invocation-1:1:b')
    expect(await f.run(scripted(['done']), { action: 'approve', checkpoint: second })).toEqual({ kind: 'completed', output: 'done' })
    expect(f.execute).toHaveBeenCalledTimes(2)
  })

  it('records rejection without executing the pending action', async () => {
    const f = fixture()
    const saved = checkpoint(await f.run(scripted([[call('a', 'no')]])))
    const inspect: typeof runPipali = async (request) => {
      expect(request.id).toBe(f.invocation.invocationId)
      expect(JSON.parse(request.history.steps.at(-1)!.observation!.results[0]!.content)).toEqual({ rejected: true, executed: false })
      return { history: request.history, rounds: request.rounds + 1, text: 'Not sent.' }
    }
    expect(await f.run(inspect, { action: 'reject', checkpoint: saved })).toEqual({ kind: 'completed', output: 'Not sent.' })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('does not repeat completed receipts when a continuation is retried', async () => {
    const f = fixture()
    const saved = checkpoint(await f.run(scripted([[call('a', 'one')]])))
    await f.run(scripted(['done']), { action: 'approve', checkpoint: saved })
    await f.run(scripted(['done']), { action: 'approve', checkpoint: saved })
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('rejects changed approved arguments, configuration and invocation', async () => {
    const f = fixture()
    const saved = checkpoint(await f.run(scripted([[call('a', 'one')]])))
    await expect(f.run(scripted(['bad']), { action: 'approve', checkpoint: { ...saved, input: { body: 'changed' } } })).rejects.toThrow('arguments changed')
    await expect(f.run(scripted(['bad']), { action: 'approve', checkpoint: saved }, { ...task, name: 'changed' })).rejects.toThrow('configuration changed')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('rejects missing retained results on a later approval', async () => {
    const f = fixture()
    const first = checkpoint(await f.run(scripted([[call('a', 'one'), call('b', 'two')]])))
    const second = checkpoint(await f.run(scripted([]), { action: 'approve', checkpoint: first }))
    f.values.clear()
    await expect(f.run(scripted(['bad']), { action: 'approve', checkpoint: second })).rejects.toThrow('unavailable or changed')
  })

  it('corrects invalid JSON with no tool authority', async () => {
    const f = fixture()
    const definition = {
      ...task,
      outputs: [
        {
          handle: 'output',
          nullable: false,
          jsonSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false },
        },
      ],
    }
    let n = 0
    const engine: typeof runPipali = async (request) => {
      if (n++) expect(request.tools).toEqual([])
      return { history: request.history, rounds: request.rounds + 1, text: n === 1 ? 'bad' : '{"answer":42}' }
    }
    expect(await f.run(engine, undefined, definition)).toEqual({ kind: 'completed', output: { answer: 42 } })
  })

  it('rejects undeclared tool calls before effects', async () => {
    const f = fixture()
    await expect(f.run(scripted([[call('a', 'x', 'shell_command')]]))).rejects.toThrow('undeclared')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('does not continue a batch after an uncertain failure', async () => {
    const f = fixture()
    f.execute.mockRejectedValueOnce(new Error('unknown external outcome'))
    const noApproval = {
      ...task,
      executor: {
        ...task.executor,
        tools: task.executor.kind === 'agent' ? task.executor.tools.map((tool) => Object.assign({}, tool, { approval: false })) : [],
      },
    } as ManagedTaskDefinition
    await expect(f.run(scripted([[call('a', 'one'), call('b', 'two')], 'bad']), undefined, noApproval)).rejects.toThrow('unknown external outcome')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
})
