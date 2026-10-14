CREATE TABLE mcp_debug_logs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  request_headers TEXT NOT NULL,
  rpc_method TEXT,
  rpc_error_code INTEGER,
  response_status INTEGER,
  response_headers TEXT,
  state TEXT NOT NULL DEFAULT 'received',
  duration_ms INTEGER
);
CREATE INDEX mcp_debug_logs_expiry ON mcp_debug_logs(expires_at);
CREATE INDEX mcp_debug_logs_created ON mcp_debug_logs(created_at);
CREATE TABLE mcp_debug_log_chunks (
  log_id TEXT NOT NULL REFERENCES mcp_debug_logs(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('request', 'response')),
  sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (log_id, direction, sequence)
);
