CREATE TABLE attachment_uploads (
  token_hash TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  key_id TEXT NOT NULL REFERENCES api_keys(id),
  grant_id TEXT REFERENCES oauth_grants(id),
  password_hash TEXT,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size INTEGER CHECK (expected_size IS NULL OR (expected_size >= 0 AND expected_size <= 10485760)),
  expires_at TEXT NOT NULL,
  claimed_by TEXT
);
CREATE INDEX attachment_uploads_expiry ON attachment_uploads(expires_at);
