/** Defense in depth for old transcripts and new messages. Never extract these into credentials. */
export function redactChatSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:mnfst_|sk-ant-|sk-|sk_)[A-Za-z0-9_-]{16,}/g, '[redacted credential]')
}
