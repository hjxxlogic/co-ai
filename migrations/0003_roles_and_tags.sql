CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (project_id, name)
);
CREATE INDEX roles_project ON roles(project_id, id);

ALTER TABLE items ADD COLUMN role_id TEXT REFERENCES roles(id);
ALTER TABLE items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array');
CREATE INDEX items_created ON items(project_id, created_at, id);
CREATE INDEX items_role_created ON items(project_id, role_id, created_at, id);
