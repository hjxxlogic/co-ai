CREATE TABLE mcp_event_subscriptions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  key_id TEXT NOT NULL REFERENCES api_keys(id),
  grant_id TEXT REFERENCES oauth_grants(id),
  password_hash TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  callback_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  previous_secret TEXT,
  rotation_until INTEGER NOT NULL DEFAULT 0,
  verified_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  pending_count INTEGER NOT NULL DEFAULT 0,
  first_message_id TEXT,
  last_message_id TEXT,
  first_received_at TEXT,
  last_received_at TEXT,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  event_body TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mcp_event_subscription_project ON mcp_event_subscriptions(project_id, expires_at);
CREATE INDEX mcp_event_subscription_due ON mcp_event_subscriptions(next_attempt);
CREATE TRIGGER mcp_message_created AFTER INSERT ON items
WHEN NEW.kind = 'message' AND NEW.deleted_at IS NULL
BEGIN
  UPDATE mcp_event_subscriptions
  SET pending_count = pending_count + 1,
      first_message_id = CASE WHEN pending_count = 0 THEN NEW.id ELSE first_message_id END,
      first_received_at = CASE WHEN pending_count = 0 THEN NEW.created_at ELSE first_received_at END,
      last_message_id = NEW.id,
      last_received_at = NEW.created_at,
      next_attempt = CASE WHEN pending_count = 0 AND event_body IS NULL THEN MAX(next_attempt, unixepoch() * 1000 + 60000) ELSE next_attempt END
  WHERE project_id = NEW.project_id AND expires_at > unixepoch() * 1000
    AND (NEW.role_id IS NULL OR NEW.role_id != role_id)
    AND EXISTS (SELECT 1 FROM roles WHERE id = role_id AND archived_at IS NULL)
    AND EXISTS (SELECT 1 FROM json_each(NEW.recipient_role_ids) WHERE value = 'ALL' OR value = mcp_event_subscriptions.role_id);
END;
