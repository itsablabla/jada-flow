import type { LlmHost } from '../deployment/llm.ts'
import type { PipaliTool } from '../deployment/pipali-contract.ts'
import type { CopilotStore, CopilotTurn } from '../storage/copilot-store.ts'
import type { ControlService } from './control-service.ts'

import { mcpTools } from '@oomol-lab/open-flow/mcp'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runPipali } from '../deployment/pipali-client.ts'
import { createPipaliHistory } from '../deployment/pipali-contract.ts'
import { ControlError } from '../error.ts'

class QuestionNeeded extends Error {}

export class CopilotService {
  private readonly active = new Map<string, AbortController>()
  private readonly store: CopilotStore
  private readonly control: ControlService
  private readonly llm: () => LlmHost | undefined
  private readonly engine: typeof runPipali
  constructor(store: CopilotStore, control: ControlService, llm: () => LlmHost | undefined, engine: typeof runPipali = runPipali) {
    this.store = store
    this.control = control
    this.llm = llm
    this.engine = engine
  }

  read(actorId: string, flowId: string, after = 0) {
    this.control.authorize(actorId, { flowId })
    return {
      turns: this.store.list(actorId, flowId).map(({ actorId: _actor, requestDigest: _digest, ...turn }) => turn),
      events: this.store.events(actorId, flowId, after).map(({ cursor, payload }) => Object.assign(JSON.parse(payload), { cursor })),
      configured: this.llm()?.config != null,
    }
  }

  stop(actorId: string, flowId: string): boolean {
    this.control.authorize(actorId, { flowId })
    const controller = this.active.get(`${actorId}:${flowId}`)
    controller?.abort(new Error('Stopped by user.'))
    return controller !== undefined
  }

  close(): void {
    for (const controller of this.active.values()) controller.abort(new Error('Server shutting down.'))
  }

  start(actorId: string, flowId: string, requestId: string, message: string, selectedNode?: string): CopilotTurn {
    this.control.authorize(actorId, { flowId })
    if (/(?:mnfst_|sk-ant-|sk-)[A-Za-z0-9_-]{16,}/.test(message))
      throw new Error('Use the secure connection settings instead of pasting credentials into chat.')
    const digest = createHash('sha256').update(JSON.stringify({ message, selectedNode })).digest('hex')
    const previous = this.store.find(actorId, flowId, requestId)
    if (previous) {
      if (previous.requestDigest !== digest) throw new Error('Request identity was already used for different content.')
      return previous
    }
    const key = `${actorId}:${flowId}`
    if (this.active.has(key)) throw new Error('A copilot turn is already running for this workflow.')
    if (this.active.size >= 2) throw new Error('The copilot is busy. Wait for a running turn to finish.')
    const model = this.llm()?.config
    if (!model) throw new Error('Configure the model connection in Settings first.')
    const turn: CopilotTurn = {
      turnId: randomUUID(),
      flowId,
      actorId,
      requestId,
      requestDigest: digest,
      status: 'running',
      message,
      answer: '',
      question: null,
      revisionId: null,
      createdAt: Date.now(),
    }
    const controller = new AbortController()
    this.active.set(key, controller)
    try {
      this.store.add(turn)
    } catch (error) {
      this.active.delete(key)
      throw error
    }
    void this.work(turn, model, controller.signal, selectedNode)
      .catch(() => {
        this.store.finish(turn.turnId, 'failed', 'The copilot could not start. Check the runtime configuration.')
      })
      .finally(() => this.active.delete(key))
    return turn
  }

  private async work(turn: CopilotTurn, model: { origin: string; token: string }, signal: AbortSignal, selectedNode?: string) {
    const { actorId, flowId, turnId } = turn
    const definitions: PipaliTool[] = []
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
    const progress = (event: unknown) => this.store.append(turnId, { turnId, ...(event as object) })
    const register = <Args>(
      name: string,
      definition: {
        description: string
        inputSchema: { '~standard': { jsonSchema: { input(): Record<string, unknown> }; validate(value: unknown): { value: Args } | { issues: unknown[] } } }
      },
      execute: (args: Args) => unknown | Promise<unknown>,
    ) => {
      definitions.push({ name, description: definition.description, schema: definition.inputSchema['~standard'].jsonSchema.input() })
      handlers.set(name, async (input) => {
        signal.throwIfAborted()
        this.control.authorize(actorId, { flowId })
        const parsed = definition.inputSchema['~standard'].validate(input)
        if ('issues' in parsed) throw new Error(`Invalid arguments for ${name}. Read the tool schema and retry.`)
        const scope = parsed.value as { flowId?: string }
        if (scope.flowId !== undefined && scope.flowId !== flowId) throw new Error('This copilot can operate only on the current workflow.')
        return execute(parsed.value)
      })
    }
    register('flow_read', mcpTools.flow_read, ({ flowId: _id, ...query }) => this.control.readAuthoring(flowId, query))
    register('flow_search', mcpTools.flow_search, ({ flowId: _id, ...query }) => this.control.searchAuthoring(flowId, query))
    register('flow_schema', mcpTools.flow_schema, ({ flowId: _id, ...query }) => this.control.authoringSchema(flowId, query))
    register('flow_edit', mcpTools.flow_edit, async ({ flowId: _id, ...request }) => {
      if (selectedNode && request.edits.some((edit) => !('node' in edit) || edit.node !== selectedNode))
        throw new Error('Only the selected node may be edited in this turn.')
      const result = await this.control.editAuthoring(actorId, flowId, request)
      progress({ kind: 'saved', revision: result.revision, changes: result.changes, validation: result.validation.status })
      return result
    })
    register('flow_check', mcpTools.flow_check, ({ revisionId }) => this.control.checkAuthoring(flowId, revisionId))
    register('connector_search', mcpTools.connector_search, ({ query }) => this.control.searchConnectorActions(query, flowId, signal, undefined, actorId))
    register('connector_get', mcpTools.connector_get, ({ actionId }) => this.control.getConnectorAction(actionId, flowId, signal, undefined, actorId))
    register('connector_connections', mcpTools.connector_connections, ({ serviceId }) =>
      this.control.listConnectorConnections(serviceId, flowId, signal, actorId),
    )
    register('trigger_get', mcpTools.trigger_get, ({ key }) => this.control.getTriggerKey(key))
    definitions.push({
      name: 'ask_user',
      description: 'Pause for one missing decision or connection. Never ask for a secret in chat. Direct connection setup to native Settings.',
      schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false },
    })
    handlers.set('ask_user', async (args) => {
      const question = z.strictObject({ question: z.string().min(1).max(2000) }).parse(args).question
      this.store.finish(turnId, 'needs-input', question, this.control.getFlow(flowId).draftRevisionId, question)
      progress({ kind: 'question', question })
      throw new QuestionNeeded(question)
    })
    try {
      const history = createPipaliHistory(turnId, process.env.JADA_COPILOT_MODEL ?? 'auto', '')
      history.steps = []
      for (const previous of this.store.list(actorId, flowId).slice(-20)) {
        history.steps.push({
          step_id: history.steps.length + 1,
          timestamp: new Date(previous.createdAt).toISOString(),
          source: 'user',
          message: previous.message,
        })
        if (previous.answer)
          history.steps.push({
            step_id: history.steps.length + 1,
            timestamp: new Date(previous.createdAt).toISOString(),
            source: 'agent',
            message: previous.answer,
          })
      }
      const response = await this.engine(
        {
          id: turnId,
          profile: 'authoring',
          model: { origin: new URL('v1/', model.origin).href, token: model.token, name: process.env.JADA_COPILOT_MODEL ?? 'auto' },
          systemPrompt: [
            'You are Pipali, the workflow-building copilot in Jada Flow. You own planning, authoring and repair.',
            `Current flow ID: ${flowId}. ${selectedNode ? `You may edit only node ${selectedNode}.` : ''}`,
            'Read the graph and relevant native schemas before writing. Discover integrations instead of inventing Action IDs, fields or credentials.',
            'Use flow_edit to save real native nodes, executable JavaScript, execution edges and explicit data mappings. These are different connections.',
            'Use an Agent for multi-step tool work. Its engine is Pipali; set the model to the configured model or auto. Do not use an LLM node as a pretend Agent.',
            'Use native Approval and Wait nodes where decisions are required. Keep external side effects behind explicit review.',
            'Each edit pins baseRevision and requestId. Preserve request IDs on retries. On a conflict, reread; do not overwrite manual changes.',
            'Missing credentials require native Settings and ask_user. Never place secrets in prompts or graph fields.',
            'You cannot run, publish, enable triggers, approve tool calls, access shell/files or send messages from this authoring session.',
            'Create missing logic as inspectable Code Tasks. Fix validation errors. A saved draft is not a tested automation.',
            'Call flow_check on the final saved revision. Finish with a short truthful summary and list anything still missing.',
          ].join('\n'),
          history,
          tools: definitions,
          rounds: 0,
          maxRounds: 24,
        },
        {
          event: async (event) => progress(event),
          dispatch: async (batch) => {
            const results = []
            for (const call of batch.step.tool_calls ?? []) {
              signal.throwIfAborted()
              const handler = handlers.get(call.function_name)
              if (!handler) throw new Error('Copilot requested an undeclared capability.')
              progress({ kind: 'tool', name: call.function_name })
              try {
                const result = await handler(call.arguments)
                results.push({ source_call_id: call.tool_call_id, content: JSON.stringify(result) })
              } catch (error) {
                if (error instanceof QuestionNeeded || signal.aborted) throw error
                const message = error instanceof ControlError || error instanceof Error ? error.message : 'Tool call failed.'
                results.push({ source_call_id: call.tool_call_id, content: JSON.stringify({ error: message }) })
              }
            }
            return results
          },
        },
        signal,
      )
      signal.throwIfAborted()
      const revision = this.control.getFlow(flowId).draftRevisionId
      const checked = await this.control.checkAuthoring(flowId, revision)
      this.store.finish(turnId, checked.valid ? 'completed' : 'draft', response.text || 'Draft saved. Review the validation results.', revision)
      progress({ kind: 'finished', valid: checked.valid, revision })
    } catch (error) {
      if (error instanceof QuestionNeeded) return
      const status = signal.aborted ? 'canceled' : 'failed'
      if (!signal.aborted) {
        const detail = (error instanceof Error ? error.message : 'Unknown engine error')
          .replaceAll(model.token, '[credential]')
          .replace(/(?:mnfst_|sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[credential]')
          .replace(/[A-Za-z0-9_-]{24,}/g, '[identifier]')
          .slice(0, 500)
        console.error(JSON.stringify({ category: 'copilot.failed', turnId, detail }))
      }
      this.store.finish(
        turnId,
        status,
        signal.aborted
          ? 'Stopped. Any changes already saved remain on the canvas.'
          : 'The copilot could not finish. Saved changes are retained; check the model connection and retry.',
      )
      progress({ kind: 'finished', status })
    }
  }
}
