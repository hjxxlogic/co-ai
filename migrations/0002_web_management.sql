ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE projects ADD COLUMN archived_at TEXT;

CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  key_id TEXT REFERENCES api_keys(id),
  admin_hash TEXT,
  expires_at TEXT NOT NULL,
  CHECK ((role = 'admin' AND key_id IS NULL AND admin_hash IS NOT NULL) OR
         (role = 'user' AND key_id IS NOT NULL AND admin_hash IS NULL))
);
CREATE INDEX web_sessions_expiry ON web_sessions(expires_at);
