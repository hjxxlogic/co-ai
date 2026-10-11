ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE;
ALTER TABLE users ADD COLUMN password_hash TEXT;
CREATE UNIQUE INDEX users_username ON users(username) WHERE username IS NOT NULL;

-- Password sessions need a stable actor for item/attachment attribution, never a public API key.
ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'api' CHECK (kind IN ('api', 'password'));
CREATE UNIQUE INDEX keys_password_actor ON api_keys(user_id) WHERE kind = 'password';

ALTER TABLE web_sessions ADD COLUMN password_hash TEXT;

CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
