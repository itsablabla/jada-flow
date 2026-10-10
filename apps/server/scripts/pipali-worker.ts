/**
 * Private Bun child process. The host owns authorization, dispatch and persistence.
 * No built-in Pipali tools, external MCP clients, shell or shared memories are exposed.
 */
import type { PipaliRequest, PipaliStep } from '../node/deployment/pipali-contract.ts'

import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const root = process.env.JADA_PIPALI_SOURCE
if (!root) throw new Error('JADA_PIPALI_SOURCE is required')
const load = (relative: string) => import(pathToFileURL(path.join(root, relative)).href)
const emit = (value: unknown) => process.stdout.write(`JADA_EVENT ${JSON.stringify(value)}\n`)
const { db } = await load('src/server/db/index.ts')
const { migrate } = await load('node_modules/drizzle-orm/pglite/migrator.js')
await migrate(db, { migrationsFolder: path.join(root, 'drizzle') })
const { AiModelApi, ChatModel } = await load('src/server/db/schema.ts')
const { research, buildSystemPrompt } = await load('src/server/processor/director/index.ts')
let reply: ((value: unknown) => void) | undefined
let busy = false

async function run(request: PipaliRequest) {
  let rounds = request.rounds
  const history = structuredClone(request.history)
  let pending: PipaliStep | undefined
  const basePrompt =
    request.profile === 'authoring' ? await buildSystemPrompt({ startedAt: new Date(), conversationRole: 'delegated', memoriesEnabled: false }) : ''
  const [api] = await db.insert(AiModelApi).values({ name: request.id, apiKey: request.model.token, apiBaseUrl: request.model.origin }).returning()
  const [model] = await db
    .insert(ChatModel)
    .values({ name: request.model.name, modelType: 'openai', aiModelApiId: api.id, useResponsesApi: true, supportsToolSearch: false })
    .returning()
  emit({ kind: 'engine', framework: `pipali/d1efc3cc315c1a0ece86ff490af9e0ff7788219d/jada-v1` })
  let text = ''
  for await (const item of research({
    chatHistory: history,
    systemPrompt: basePrompt ? `${basePrompt}\n\nEmbedding host contract:\n${request.systemPrompt}` : request.systemPrompt,
    chatModelId: model.id,
    currentIteration: rounds,
    maxIterations: request.maxRounds,
    memoriesEnabled: false,
    providerToolSearch: 'off',
    conversationRole: 'delegated',
    conversationId: request.id,
    runId: request.id,
    hostTools: request.tools,
    onStreamEvent: (event: { kind: string; delta?: string }) => {
      if (event.kind === 'text' && event.delta) emit({ kind: 'text', delta: event.delta })
    },
    hostDispatch: async () => {
      if (!pending) throw new Error('No pending tool batch')
      const response = new Promise((resolve) => {
        reply = resolve
      })
      emit({ kind: 'batch', history, step: pending, rounds })
      return response
    },
  })) {
    if (item.isToolCallStart) {
      rounds++
      pending = {
        step_id: history.steps.length + 1,
        timestamp: new Date().toISOString(),
        source: 'agent',
        message: item.message || '',
        tool_calls: item.toolCalls,
        extra: { raw: item.raw ?? [] },
      }
      continue
    }
    if (item.warning) throw new Error(`Provider response: ${item.warning}`)
    if (item.toolResults) {
      if (!pending) throw new Error('Unexpected tool result')
      history.steps.push({ ...pending, observation: { results: item.toolResults } })
      pending = undefined
    } else {
      rounds++
      text = item.message || ''
      history.steps.push({ step_id: history.steps.length + 1, timestamp: new Date().toISOString(), source: 'agent', message: text })
    }
  }
  emit({ kind: 'completed', text, rounds, history })
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
emit({ kind: 'ready' })
for await (const line of lines) {
  try {
    const message = JSON.parse(line)
    if (message.kind === 'observations' && reply) {
      const resolve = reply
      reply = undefined
      resolve(message.results)
    } else if (message.kind === 'run' && !busy) {
      busy = true
      void run(message.request)
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : 'unknown'
          const safe = detail
            .replaceAll(message.request.model.token, '[credential]')
            .replace(/[A-Za-z0-9_-]{24,}/g, '[identifier]')
            .slice(0, 300)
          emit({ kind: 'error', message: `Pipali engine failed: ${safe}` })
        })
        .finally(() => {
          busy = false
        })
    } else {
      emit({ kind: 'error', message: 'Invalid worker state.' })
    }
  } catch {
    emit({ kind: 'error', message: 'Invalid worker input.' })
  }
}
