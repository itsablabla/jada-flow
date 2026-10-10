CREATE TABLE jada_mcp_connections (
  connection_id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(flow_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  encrypted_token TEXT,
  tools_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(flow_id, url)
);
