CREATE VIRTUAL TABLE items_search USING fts5(title, content, content='items', content_rowid='rowid', tokenize='trigram');
INSERT INTO items_search(items_search) VALUES ('rebuild');
CREATE TRIGGER items_search_insert AFTER INSERT ON items BEGIN
  INSERT INTO items_search(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
END;
CREATE TRIGGER items_search_delete AFTER DELETE ON items BEGIN
  INSERT INTO items_search(items_search, rowid, title, content) VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
END;
CREATE TRIGGER items_search_update AFTER UPDATE OF title, content ON items BEGIN
  INSERT INTO items_search(items_search, rowid, title, content) VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
  INSERT INTO items_search(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
END;
