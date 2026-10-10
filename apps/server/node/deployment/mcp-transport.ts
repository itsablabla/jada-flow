import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

export interface RemoteMcpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}
export type McpRemote = (
  url: string,
  token: string | undefined,
  method: 'list' | 'call',
  args?: { name: string; arguments: Record<string, unknown> },
  signal?: AbortSignal,
) => Promise<unknown>

export function publicMcpUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443'))
    throw new Error('Use a public HTTPS MCP URL without credentials, query parameters or a custom port.')
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || isIP(url.hostname.replace(/[[\]]/g, '')))
    throw new Error('MCP URLs must use a public DNS hostname.')
  return url
}

export function publicMcpAddress(address: string): boolean {
  // Use routable IPv4 only. IPv6 is conservatively rejected, including mapped IPv4.
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return (
    a !== undefined &&
    b !== undefined &&
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || b === 2)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
    !(a === 203 && b === 0)
  )
}

/** DNS is validated and pinned for each request, with no redirects or ambient proxy credentials. */
export async function safeMcpFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init)
  const url = publicMcpUrl(req.url)
  const addresses = await lookup(url.hostname, { all: true })
  const chosen = addresses.find((item) => publicMcpAddress(item.address))
  if (!chosen || addresses.some((item) => item.family === 4 && !publicMcpAddress(item.address)))
    throw new Error('MCP server resolves to a blocked network address.')
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer())
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(60_000)])
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: req.method,
        headers: Object.fromEntries(req.headers),
        signal,
        lookup: ((_hostname: unknown, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
          options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)) as never,
      },
      (response) => {
        const status = response.statusCode ?? 502
        if (status >= 300 && status < 400) {
          response.destroy()
          reject(new Error('MCP redirects are not allowed.'))
          return
        }
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 8 * 1024 * 1024) response.destroy(new Error('MCP response exceeded its size limit.'))
        })
        resolve(new Response(status === 204 || status === 304 ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status, headers }))
      },
    )
    request.on('error', reject)
    request.end(body)
  })
}

export function createMcpRemote(fetchImplementation: typeof safeMcpFetch = safeMcpFetch): McpRemote {
  return async (url, token, method, args, signal) => {
    const client = new Client({ name: 'jada-flow', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(publicMcpUrl(url), {
      fetch: fetchImplementation,
      requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {}, signal },
    })
    try {
      await client.connect(transport)
      if (method === 'call') return await client.callTool(args!, { signal, timeout: 60_000 })
      const tools: RemoteMcpTool[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 20_000 })
        tools.push(...result.tools)
        if (tools.length > 500) throw new Error('MCP server has more than 500 tools. Use a smaller tool surface.')
        if (!result.nextCursor) return tools
        if (result.nextCursor === cursor) throw new Error('MCP tool pagination did not advance.')
        cursor = result.nextCursor
      }
      throw new Error('MCP tool pagination exceeded its limit.')
    } finally {
      await client.close().catch(() => {})
    }
  }
}
export const callRemoteMcp = createMcpRemote()
