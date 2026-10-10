/** Defense in depth for transcript text; direct connection credentials use a separate request field. */
export function redactChatSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:mnfst_|sk-ant-|sk-|sk_)[A-Za-z0-9_-]{16,}/g, '[redacted credential]')
}

/** Parse explicit connection commands only. Never pass the returned token to a model or transcript. */
export function parseMcpConnectionMessage(value: string): { url: string; token: string } | undefined {
  const match = value.match(/^\s*(?:add|connect|attach)\s+(?:an?\s+)?(?:mcp\s+(?:server\s+)?)?(https:\/\/[^\s]+)\s+(?:authorization\s*:\s*)?bearer\s+([A-Za-z0-9._~+/-]+=*)\s*$/i)
  if (!match || match[1]!.length > 2048 || match[2]!.length > 8192) return undefined
  return { url: match[1]!, token: match[2]! }
}
