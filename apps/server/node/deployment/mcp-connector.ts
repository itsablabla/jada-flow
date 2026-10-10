import type { ConnectorHost, ConnectorAccessContext } from './connector.ts'
import type { McpConnections } from './mcp-connections.ts'

import { ConnectorTaskError } from './connector.ts'

const flow = (access?: ConnectorAccessContext) => access?.flowId ?? ''
const missing = () => {
  throw new ConnectorTaskError('connector.unconfigured', 'No Connector is configured. Add an MCP server through the copilot.')
}
export function withMcpConnections(mcp: McpConnections, base?: ConnectorHost): ConnectorHost {
  return {
    ready: async () => mcp.hasAny() || !!(await base?.ready()),
    async listProviders(signal, access, locale) {
      return [
        ...((await base?.listProviders(signal, access, locale)) ?? []),
        ...mcp
          .rows(flow(access))
          .filter((r) => r.status === 'active')
          .map((r) => ({ serviceId: r.connection_id, serviceName: r.label })),
      ]
    },
    async listAllConnections(signal, access) {
      return [
        ...((await base?.listAllConnections(signal, access)) ?? []),
        ...mcp
          .rows(flow(access))
          .filter((r) => r.status === 'active')
          .map((r) => ({
            connectionId: r.connection_id,
            serviceId: r.connection_id,
            displayName: r.label,
            status: 'active' as const,
            isDefault: true,
          })),
      ]
    },
    async listConnections(service, signal, access) {
      return (await this.listAllConnections(signal, access)).filter((c) => c.serviceId === service)
    },
    async listActions(service, signal, access, locale) {
      return [
        ...(service?.startsWith('jada_mcp_') ? [] : ((await base?.listActions(service, signal, access, locale)) ?? [])),
        ...mcp.actions(flow(access)).filter((a) => !service || a.serviceId === service),
      ]
    },
    async searchActions(query, signal, access, locale) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      return [
        ...((await base?.searchActions(query, signal, access, locale)) ?? []),
        ...mcp.actions(flow(access)).filter((a) => terms.every((term) => `${a.name} ${a.description} ${a.serviceName}`.toLowerCase().includes(term))),
      ]
    },
    async getAction(id, signal, access, locale) {
      if (!id.startsWith('jada_mcp_')) return base?.getAction(id, signal, access, locale) ?? missing()
      const action = mcp.actions(flow(access)).find((a) => a.actionId === id)
      if (!action) throw new ConnectorTaskError('connector.action-not-found', 'MCP action is not in this workflow.')
      return action
    },
    async execute(action, connectionId, input, invocationId, signal, access) {
      if (!action.startsWith('jada_mcp_')) return base?.execute(action, connectionId, input, invocationId, signal, access) ?? missing()
      if (
        !access?.mcpApproved ||
        access.scope !== 'action' ||
        access.action !== action ||
        access.connectionId !== connectionId ||
        !connectionId ||
        !access.flowId
      )
        throw new ConnectorTaskError('connector.access-required', 'MCP tools require approval through an Agent node.')
      return mcp.execute(access.flowId, connectionId, action, { ...input }, signal)
    },
    async proxy(...args) {
      return base?.proxy(...args) ?? missing()
    },
    async trigger(...args) {
      return base?.trigger?.(...args) ?? missing()
    },
  }
}
