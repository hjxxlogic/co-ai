-- Access sessions use the existing internal actor, with separate identity checks.
ALTER TABLE web_sessions ADD COLUMN access_email TEXT;
ALTER TABLE web_sessions ADD COLUMN access_config_hash TEXT;
