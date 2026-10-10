import type { CopilotService } from '../application/copilot-service.ts'

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { parseMcpConnectionMessage } from '../../common/chat-secrets.ts'

export function createCopilotApp(service: CopilotService, authenticate: (request: Request) => Promise<string>, shutdown?: AbortSignal) {
  const app = new Hono()
  shutdown?.addEventListener('abort', () => service.close(), { once: true })
  for (const route of ['/:flowId/copilot', '/:flowId/copilot/*']) {
    app.use(route, bodyLimit({ maxSize: 32 * 1024 }), async (context, next) => {
      context.header('cache-control', 'no-store')
      const origin = context.req.header('origin')
      if (origin && origin !== new URL(context.req.url).origin) return context.json({ error: 'Origin is not allowed.' }, 403)
      await next()
    })
  }
  app.get('/:flowId/copilot', async (context) => {
    const actor = await authenticate(context.req.raw)
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(context.req.query('after') ?? 0)
    return context.json(service.read(actor, context.req.param('flowId'), after))
  })
  app.post('/:flowId/copilot', async (context) => {
    const actor = await authenticate(context.req.raw)
    const body = z
      .strictObject({
        requestId: z.string().min(1).max(128),
        message: z.string().trim().min(1).max(16000),
        selectedNode: z.string().min(1).max(128).optional(),
      })
      .parse(await context.req.json())
    const connection = parseMcpConnectionMessage(body.message)
    if (connection) return context.json(await service.connectMcpDirect(actor, context.req.param('flowId'), body.requestId, connection.url, connection.token))
    const turn = service.start(actor, context.req.param('flowId'), body.requestId, body.message, body.selectedNode)
    return context.json({ turnId: turn.turnId, status: turn.status }, 202)
  })
  app.post('/:flowId/copilot/stop', async (context) => {
    const actor = await authenticate(context.req.raw)
    return context.json({ accepted: service.stop(actor, context.req.param('flowId')) })
  })
  app.post('/:flowId/copilot/mcp/connect', async (context) => {
    const actor = await authenticate(context.req.raw)
    const body = z
      .strictObject({
        requestId: z.string().min(1).max(128),
        url: z.string().url().max(2048),
        token: z.string().min(1).max(8192),
      })
      .parse(await context.req.json())
    return context.json(await service.connectMcpDirect(actor, context.req.param('flowId'), body.requestId, body.url, body.token))
  })
  app.post('/:flowId/copilot/mcp/:connectionId/auth', async (context) => {
    const actor = await authenticate(context.req.raw)
    const body = z.strictObject({ token: z.string().min(1).max(8192) }).parse(await context.req.json())
    try {
      return context.json(await service.authorizeMcp(actor, context.req.param('flowId'), context.req.param('connectionId'), body.token, context.req.raw.signal))
    } catch {
      return context.json(
        { error: 'Could not connect. Check the server URL and token. Only public HTTPS Streamable HTTP MCP with optional bearer authentication is supported.' },
        400,
      )
    }
  })
  return app
}
