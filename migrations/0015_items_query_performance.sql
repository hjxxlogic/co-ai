CREATE INDEX items_live_created ON items(project_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX items_live_kind_created ON items(project_id, kind, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX items_live_status_kind_created ON items(project_id, status, kind, created_at, id) WHERE deleted_at IS NULL;

CREATE TABLE item_tags (
  project_id TEXT NOT NULL REFERENCES projects(id),
  tag TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, tag, item_id)
) WITHOUT ROWID;
CREATE INDEX item_tags_item ON item_tags(item_id);
INSERT INTO item_tags (project_id, tag, item_id)
  SELECT DISTINCT i.project_id, t.value, i.id FROM items i, json_each(i.tags) t;
CREATE TRIGGER item_tags_insert AFTER INSERT ON items BEGIN
  INSERT INTO item_tags (project_id, tag, item_id)
    SELECT DISTINCT NEW.project_id, value, NEW.id FROM json_each(NEW.tags);
END;
CREATE TRIGGER item_tags_update AFTER UPDATE OF tags, project_id ON items
WHEN OLD.tags IS NOT NEW.tags OR OLD.project_id IS NOT NEW.project_id BEGIN
  DELETE FROM item_tags WHERE item_id = OLD.id;
  INSERT INTO item_tags (project_id, tag, item_id)
    SELECT DISTINCT NEW.project_id, value, NEW.id FROM json_each(NEW.tags);
END;

DROP TRIGGER items_search_update;
CREATE TRIGGER items_search_update AFTER UPDATE OF title, content ON items
WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content BEGIN
  INSERT INTO items_search(items_search, rowid, title, content) VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
  INSERT INTO items_search(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
END;
