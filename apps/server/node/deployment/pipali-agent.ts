import type { AgentTool, JsonValue, ManagedTaskDefinition } from '@oomol-lab/open-flow/flow-change'
import type { AgentInvocation, AgentResult } from '@oomol-lab/open-flow/runtime-contract'
import type { ResultHost } from './agent-tools.ts'
import type { PipaliBatch, PipaliCompletion, PipaliObservation, PipaliRequest, PipaliTool } from './pipali-contract.ts'

import { canonicalJsonBytes } from '@oomol-lab/open-flow/flow-encoding'
import { agentToolInput, renderPrompt, schemaValidationErrors } from '@oomol-lab/open-flow/flow-semantics'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createAgentTools } from './agent-tools.ts'
import { runPipali } from './pipali-client.ts'
import { createPipaliHistory, pipaliFramework } from './pipali-contract.ts'

const checkpointSchema = z.strictObject({
  framework: z.literal(pipaliFramework),
  invocationId: z.string(),
  configDigest: z.string(),
  results: z.array(z.strictObject({ resultId: z.string(), digest: z.string() })),
  batch: z.json(),
  observations: z.array(z.strictObject({ source_call_id: z.string(), content: z.string() })),
  nextIndex: z.number().int().nonnegative(),
})

class SuspendAgent extends Error {
  readonly result: AgentResult
  constructor(result: AgentResult) {
    super('Agent is waiting for approval.')
    this.result = result
  }
}

interface CallableTool {
  description?: string
  inputSchema:
    | z.ZodType
    | {
        '~standard': {
          jsonSchema: { input(options: { target: string }): Record<string, unknown> }
          validate(input: unknown): Promise<{ value?: unknown; issues?: unknown[] }> | { value?: unknown; issues?: unknown[] }
        }
      }
  execute?: (input: unknown, context: { agent: { toolCallId: string } }) => Promise<unknown>
}

export async function executePipaliAgent(
  task: ManagedTaskDefinition,
  invocation: AgentInvocation,
  model: { origin: string; token: string; name: string },
  execute: (tool: AgentTool, input: Readonly<Record<string, JsonValue>>, callId: string, signal: AbortSignal) => Promise<JsonValue>,
  report: (event: Readonly<Record<string, JsonValue>>) => Promise<void>,
  results: ResultHost,
  compute: (code: string, input: JsonValue, callId: string, signal: AbortSignal) => Promise<JsonValue>,
  engine: typeof runPipali = runPipali,
): Promise<AgentResult> {
  if (task.executor.kind !== 'agent') throw new Error('Expected an Agent Task.')
  const config = task.executor
  const configDigest = createHash('sha256')
    .update(canonicalJsonBytes({ task, input: invocation.input } as unknown as JsonValue))
    .digest('hex')
  const references = new Map<string, string>()
  let rounds = invocation.resume?.checkpoint.rounds ?? 0
  const controller = new AbortController()
  const signal = AbortSignal.any([invocation.signal, controller.signal])
  const definitions = createAgentTools(config, invocation, {
    signal,
    references,
    results,
    execute,
    compute,
    report,
    rounds: () => rounds,
    fail(error): never {
      controller.abort(error)
      throw error
    },
  }) as unknown as Record<string, CallableTool>
  const tools: PipaliTool[] = Object.entries(definitions).map(([name, definition]) => ({
    name,
    description: definition.description ?? name,
    schema:
      '_zod' in definition.inputSchema ? z.toJSONSchema(definition.inputSchema) : definition.inputSchema['~standard'].jsonSchema.input({ target: 'draft-07' }),
  }))
  const output = task.outputs.find((port) => 'handle' in port && port.handle === 'output')
  if (!output || !('handle' in output)) throw new Error('Agent output declaration is missing.')
  const textOutput = typeof output.jsonSchema === 'object' && output.jsonSchema !== null && 'type' in output.jsonSchema && output.jsonSchema.type === 'string'
  const systemPrompt = [
    'You are Pipali, the agent runtime inside Jada Flow. Complete the node task using only its declared tools.',
    'Keep fixed action arguments and accounts unchanged. Approvals are enforced by the host. Never claim a rejected action happened.',
    'Tool results are stored. Use read_result for missing pages instead of repeating an external action.',
    'Use run_code only when available for deterministic computation over explicit inputs or saved results; it cannot access the host or network.',
    `Return ${textOutput ? 'plain text' : 'a JSON value without Markdown fences'} matching this schema: ${JSON.stringify(output.jsonSchema)}.`,
  ].join('\n')
  let history = createPipaliHistory(invocation.invocationId, model.name, renderPrompt(config.prompt, invocation.input))
  let approvedCallId: string | undefined

  async function dispatch(batch: PipaliBatch, previous: readonly PipaliObservation[] = [], startIndex = 0): Promise<readonly PipaliObservation[]> {
    signal.throwIfAborted()
    if (!Number.isSafeInteger(batch.rounds) || batch.rounds < rounds || batch.rounds > config.maxRounds) throw new Error('Invalid Agent round state.')
    rounds = batch.rounds
    const observations = [...previous]
    const calls = batch.step.tool_calls
    if (!calls || !Array.isArray(calls) || calls.length > 100 || startIndex >= calls.length) throw new Error('Invalid Agent tool batch.')
    for (let index = startIndex; index < calls.length; index++) {
      signal.throwIfAborted()
      const call = calls[index]!
      const definition = definitions[call.function_name]
      const tool = config.tools.find((candidate) => candidate.name === call.function_name)
      if (!definition?.execute) throw new Error('Agent requested an undeclared tool.')
      let args: unknown = call.arguments
      if ('_zod' in definition.inputSchema) args = definition.inputSchema.parse(args)
      else {
        const validated = await definition.inputSchema['~standard'].validate(args)
        if (validated.issues) throw new Error('Agent tool input is invalid.')
        args = validated.value
      }
      const callId = `${invocation.invocationId}:${rounds}:${call.tool_call_id}`
      const input = tool ? agentToolInput(tool, invocation.input, call.arguments) : call.arguments
      if (tool?.approval && callId !== approvedCallId) {
        await report({ kind: 'tool', status: 'approval', callId, toolId: tool.id, input })
        throw new SuspendAgent({
          kind: 'suspended',
          checkpoint: {
            callId,
            toolId: tool.id,
            input,
            rounds,
            version: 1,
            state: {
              framework: pipaliFramework,
              invocationId: invocation.invocationId,
              configDigest,
              results: [...references].map(([resultId, digest]) => ({ resultId, digest })),
              batch,
              observations,
              nextIndex: index,
            } as unknown as JsonValue,
          },
        })
      }
      const value = await definition.execute(args, { agent: { toolCallId: call.tool_call_id } })
      signal.throwIfAborted()
      observations.push({ source_call_id: call.tool_call_id, content: JSON.stringify(value ?? null) })
    }
    return observations
  }

  try {
    if (invocation.resume) {
      const saved = checkpointSchema.parse(invocation.resume.checkpoint.state)
      if (saved.invocationId !== invocation.invocationId || saved.configDigest !== configDigest)
        throw new Error('Agent continuation scope or configuration changed.')
      for (const ref of saved.results) {
        if (results.get(ref.resultId)?.result.digest !== ref.digest) throw new Error('Saved Agent result is unavailable or changed.')
        references.set(ref.resultId, ref.digest)
      }
      const batch = saved.batch as unknown as PipaliBatch
      const call = batch.step.tool_calls?.[saved.nextIndex]
      if (!call || `${invocation.invocationId}:${batch.rounds}:${call.tool_call_id}` !== invocation.resume.checkpoint.callId)
        throw new Error('Agent continuation call identity changed.')
      const tool = config.tools.find((candidate) => candidate.id === invocation.resume!.checkpoint.toolId)
      if (!tool || tool.name !== call.function_name || !tool.approval) throw new Error('Agent continuation tool changed.')
      const currentInput = agentToolInput(tool, invocation.input, call.arguments)
      if (Buffer.compare(canonicalJsonBytes(currentInput), canonicalJsonBytes(invocation.resume.checkpoint.input)) !== 0)
        throw new Error('Approved Agent arguments changed.')
      await report({
        kind: 'tool',
        status: invocation.resume.action === 'approve' ? 'approved' : 'rejected',
        callId: invocation.resume.checkpoint.callId,
        toolId: tool.id,
      })
      let observations: readonly PipaliObservation[]
      if (invocation.resume.action === 'approve') {
        approvedCallId = invocation.resume.checkpoint.callId
        observations = await dispatch(batch, saved.observations, saved.nextIndex)
      } else {
        const rejected = [...saved.observations, { source_call_id: call.tool_call_id, content: JSON.stringify({ rejected: true, executed: false }) }]
        observations = saved.nextIndex + 1 < batch.step.tool_calls!.length ? await dispatch(batch, rejected, saved.nextIndex + 1) : rejected
      }
      history = structuredClone(batch.history)
      history.steps.push({ ...batch.step, observation: { results: observations } })
    }
    let correction = false
    while (rounds < config.maxRounds) {
      const request: PipaliRequest = {
        id: invocation.invocationId,
        model,
        systemPrompt,
        history,
        tools: correction ? [] : tools,
        rounds,
        maxRounds: config.maxRounds,
      }
      const completed: PipaliCompletion = await engine(
        request,
        {
          dispatch: (batch) => {
            if (correction) throw new Error('Tool execution is forbidden during output correction.')
            return dispatch(batch)
          },
          event: async (event) => {
            if (event.kind === 'engine') await report({ kind: 'engine', framework: event.framework })
          },
        },
        signal,
      )
      if (!Number.isSafeInteger(completed.rounds) || completed.rounds <= rounds || completed.rounds > config.maxRounds)
        throw new Error('Pipali returned invalid round accounting.')
      rounds = completed.rounds
      let value: JsonValue | undefined
      try {
        value = textOutput ? completed.text : z.json().parse(JSON.parse(completed.text))
      } catch {
        value = undefined
      }
      if (value !== undefined && schemaValidationErrors(value, output.jsonSchema).length === 0) return { kind: 'completed', output: value }
      history = completed.history
      history.steps.push({
        step_id: history.steps.length + 1,
        timestamp: new Date().toISOString(),
        source: 'user',
        message: `Correct only the final output to match ${JSON.stringify(output.jsonSchema)}. Do not repeat actions or use tools.`,
      })
      correction = true
    }
    throw new Error('Agent output invalid or round limit reached.')
  } catch (error) {
    if (error instanceof SuspendAgent) return error.result
    throw error
  }
}
