CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  session_hash TEXT,
  expires_at TEXT NOT NULL,
  consumed_by TEXT
);
CREATE INDEX oauth_requests_expiry ON oauth_requests(expires_at);

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  key_id TEXT REFERENCES api_keys(id),
  admin_hash TEXT,
  password_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((key_id IS NOT NULL AND admin_hash IS NULL) OR (key_id IS NULL AND admin_hash IS NOT NULL))
);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id);

CREATE TABLE oauth_codes (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_by TEXT
);

CREATE TABLE oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  expires_at TEXT NOT NULL
);
CREATE INDEX oauth_access_expiry ON oauth_access_tokens(expires_at);

-- Retain consumed refresh tokens until the grant expires to detect replay.
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  expires_at TEXT NOT NULL,
  consumed_by TEXT
);
CREATE INDEX oauth_refresh_grant ON oauth_refresh_tokens(grant_id);
