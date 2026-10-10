import type { PipaliCompletion, PipaliHostCallbacks, PipaliRequest } from './pipali-contract.ts'

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

/**
 * One process per invocation. Authoring reuse can be added only with proven scope isolation.
 * No ambient provider/user credentials are inherited by the child.
 */
export async function runPipali(request: PipaliRequest, host: PipaliHostCallbacks, signal: AbortSignal): Promise<PipaliCompletion> {
  signal.throwIfAborted()
  const source = process.env.JADA_PIPALI_SOURCE
  const worker = process.env.JADA_PIPALI_WORKER
  if (!source || !worker) throw new Error('Pipali source and worker are not configured.')
  if (!Number.isSafeInteger(request.maxRounds) || request.maxRounds < 1 || request.maxRounds > 100 || request.rounds >= request.maxRounds)
    throw new Error('Pipali round limit exceeded.')
  if (Buffer.byteLength(JSON.stringify(request)) > 8 * 1024 * 1024) throw new Error('Pipali context exceeds the size limit.')
  const home = await mkdtemp(path.join(tmpdir(), 'jada-pipali-'))
  const child = spawn(process.env.JADA_BUN_BIN ?? 'bun', [worker], {
    cwd: source,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      POSTGRES_DB: 'memory://',
      PIPALI_DATA_DIR: home,
      JADA_PIPALI_SOURCE: source,
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    },
  })
  const abort = () => child.kill('SIGTERM')
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timeout = setTimeout(abort, 360_000)
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let failure: Error | undefined
  child.on('error', (error) => {
    failure = error
  })
  try {
    for await (const line of input) {
      signal.throwIfAborted()
      if (!line.startsWith('JADA_EVENT ')) continue
      if (Buffer.byteLength(line) > 12 * 1024 * 1024) throw new Error('Pipali event exceeds the size limit.')
      const event = JSON.parse(line.slice(11))
      if (event.kind === 'ready') child.stdin.write(`${JSON.stringify({ kind: 'run', request })}\n`)
      else if (event.kind === 'engine' || event.kind === 'text') await host.event(event)
      else if (event.kind === 'batch') {
        const results = await host.dispatch(event)
        signal.throwIfAborted()
        child.stdin.write(`${JSON.stringify({ kind: 'observations', results })}\n`)
      } else if (event.kind === 'completed') {
        return { text: event.text, rounds: event.rounds, history: event.history }
      } else if (event.kind === 'error') throw new Error(event.message)
    }
    signal.throwIfAborted()
    throw failure ?? new Error('Pipali worker exited before completion.')
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    input.close()
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once('close', () => resolve()))
    clearTimeout(force)
    await rm(home, { recursive: true, force: true })
  }
}
