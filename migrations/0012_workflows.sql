CREATE TABLE workflow_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  current_revision_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES api_keys(id),
  updated_by TEXT NOT NULL REFERENCES api_keys(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX workflow_templates_project ON workflow_templates(project_id, id);

CREATE TABLE workflow_revisions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES workflow_templates(id),
  revision INTEGER NOT NULL,
  definition TEXT NOT NULL CHECK(json_valid(definition) AND json_type(definition) = 'object'),
  created_by TEXT NOT NULL REFERENCES api_keys(id),
  created_at TEXT NOT NULL,
  UNIQUE(template_id, revision)
);

CREATE TABLE works (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  template_id TEXT NOT NULL REFERENCES workflow_templates(id),
  revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
  title TEXT NOT NULL,
  current_state TEXT NOT NULL,
  current_message_item_id TEXT REFERENCES items(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES api_keys(id),
  updated_by TEXT NOT NULL REFERENCES api_keys(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX works_project_updated ON works(project_id, updated_at, id);
CREATE INDEX works_template ON works(project_id, template_id, id);

CREATE TABLE work_history (
  work_id TEXT NOT NULL REFERENCES works(id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('created', 'transition', 'note_updated')),
  from_state TEXT,
  to_state TEXT NOT NULL,
  message_item_id TEXT REFERENCES items(id),
  actor_key_id TEXT NOT NULL REFERENCES api_keys(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(work_id, sequence)
);
CREATE INDEX work_history_message ON work_history(message_item_id);

CREATE TRIGGER work_message_insert BEFORE INSERT ON works
WHEN NEW.current_message_item_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM items WHERE id = NEW.current_message_item_id AND project_id = NEW.project_id AND kind = 'message' AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid work message');
END;
CREATE TRIGGER work_message_update BEFORE UPDATE OF current_message_item_id ON works
WHEN NEW.current_message_item_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM items WHERE id = NEW.current_message_item_id AND project_id = NEW.project_id AND kind = 'message' AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid work message');
END;
CREATE TRIGGER work_created AFTER INSERT ON works
BEGIN
  INSERT INTO work_history (work_id, sequence, event_type, from_state, to_state, message_item_id, actor_key_id, created_at)
  VALUES (NEW.id, 1, 'created', NULL, NEW.current_state, NEW.current_message_item_id, NEW.created_by, NEW.created_at);
END;
CREATE TRIGGER work_changed AFTER UPDATE OF current_state, current_message_item_id ON works
WHEN NEW.current_state != OLD.current_state OR NEW.current_message_item_id IS NOT OLD.current_message_item_id
BEGIN
  INSERT INTO work_history (work_id, sequence, event_type, from_state, to_state, message_item_id, actor_key_id, created_at)
  VALUES (NEW.id, (SELECT MAX(sequence) + 1 FROM work_history WHERE work_id = NEW.id),
    CASE WHEN NEW.current_state != OLD.current_state THEN 'transition' ELSE 'note_updated' END,
    OLD.current_state, NEW.current_state, NEW.current_message_item_id, NEW.updated_by, NEW.updated_at);
END;
CREATE TRIGGER work_message_protected BEFORE UPDATE OF kind, deleted_at, project_id ON items
WHEN (NEW.kind != 'message' OR NEW.deleted_at IS NOT NULL OR NEW.project_id != OLD.project_id)
  AND EXISTS (SELECT 1 FROM work_history WHERE message_item_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Work message is referenced');
END;
