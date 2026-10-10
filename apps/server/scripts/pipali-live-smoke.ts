import { runPipali } from '../node/deployment/pipali-client.ts'
import { createPipaliHistory, pipaliFramework } from '../node/deployment/pipali-contract.ts'

const observed: string[] = []
const result = await runPipali(
  {
    id: 'jada-live-engine-smoke',
    model: { origin: 'http://127.0.0.1:7302/v1', token: 'workbench', name: 'auto' },
    systemPrompt: 'Use the provided arithmetic tool exactly once, then return only its numeric answer.',
    history: createPipaliHistory('jada-live-engine-smoke', 'auto', 'Use add to calculate 17 plus 25.'),
    tools: [
      {
        name: 'add',
        description: 'Add two numbers.',
        schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
      },
    ],
    rounds: 0,
    maxRounds: 5,
  },
  {
    event: async (event) => {
      if (event.kind === 'engine') {
        if (event.framework !== pipaliFramework) throw new Error('Wrong engine.')
        observed.push('engine')
      }
    },
    dispatch: async (batch) => {
      const calls = batch.step.tool_calls ?? []
      return calls.map((call) => {
        if (call.function_name !== 'add' || call.arguments.a !== 17 || call.arguments.b !== 25) throw new Error('Unexpected tool arguments.')
        observed.push('add')
        return { source_call_id: call.tool_call_id, content: '42' }
      })
    },
  },
  AbortSignal.timeout(180_000),
)
if (result.text.trim() !== '42' || observed.filter((value) => value === 'add').length !== 1) throw new Error('Real engine test failed.')
console.log(JSON.stringify({ passed: true, engine: pipaliFramework, output: result.text.trim(), rounds: result.rounds, toolCalls: 1 }))
