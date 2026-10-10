import type { JsonValue } from '@oomol-lab/open-flow/flow-change'

export const pipaliRevision = 'd1efc3cc315c1a0ece86ff490af9e0ff7788219d'
export const pipaliFramework = `pipali/${pipaliRevision}/jada-v1`

export interface PipaliCall {
  readonly tool_call_id: string
  readonly function_name: string
  readonly arguments: Readonly<Record<string, JsonValue>>
}

export interface PipaliObservation {
  readonly source_call_id: string
  readonly content: string
}

export interface PipaliStep {
  readonly step_id: number
  readonly timestamp: string
  readonly source: 'system' | 'user' | 'agent'
  readonly message?: string
  readonly tool_calls?: readonly PipaliCall[]
  readonly observation?: { readonly results: readonly PipaliObservation[] }
  readonly extra?: Readonly<Record<string, JsonValue>>
}

export interface PipaliHistory {
  readonly schema_version: 'ATIF-v1.4'
  readonly session_id: string
  readonly agent: { readonly name: string; readonly version: string; readonly model_name: string }
  steps: PipaliStep[]
}

export interface PipaliTool {
  readonly name: string
  readonly description: string
  readonly schema: Readonly<Record<string, unknown>>
}

export interface PipaliRequest {
  readonly id: string
  readonly profile?: 'authoring' | 'agent'
  readonly model: { readonly origin: string; readonly token: string; readonly name: string }
  readonly systemPrompt: string
  readonly history: PipaliHistory
  readonly tools: readonly PipaliTool[]
  readonly rounds: number
  readonly maxRounds: number
}

export interface PipaliBatch {
  readonly history: PipaliHistory
  readonly step: PipaliStep
  readonly rounds: number
}

export interface PipaliCompletion {
  readonly text: string
  readonly rounds: number
  readonly history: PipaliHistory
}

export interface PipaliHostCallbacks {
  dispatch(batch: PipaliBatch): Promise<readonly PipaliObservation[]>
  event(event: { readonly kind: 'text'; readonly delta: string } | { readonly kind: 'engine'; readonly framework: string }): Promise<void>
}

export function createPipaliHistory(id: string, model: string, prompt: string): PipaliHistory {
  return {
    schema_version: 'ATIF-v1.4',
    session_id: id,
    agent: { name: 'pipali', version: pipaliRevision, model_name: model },
    steps: [{ step_id: 1, timestamp: new Date().toISOString(), source: 'user', message: prompt }],
  }
}
