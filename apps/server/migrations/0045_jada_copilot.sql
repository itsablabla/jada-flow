CREATE TABLE jada_copilot_turns (
  turn_id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'draft', 'needs-input', 'canceled', 'interrupted', 'failed')),
  message TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  question TEXT,
  revision_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(flow_id, actor_id, request_id)
);
CREATE INDEX jada_copilot_flow_turns ON jada_copilot_turns(flow_id, actor_id, created_at);
CREATE TABLE jada_copilot_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
