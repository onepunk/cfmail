PRAGMA foreign_keys = ON;

CREATE TABLE workbooks (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL COLLATE NOCASE,
  title TEXT NOT NULL DEFAULT 'Book',
  workbook_json TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  sheet_count INTEGER NOT NULL DEFAULT 1,
  cell_count INTEGER NOT NULL DEFAULT 0,
  source_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX workbooks_owner_updated_idx
  ON workbooks(owner_email, deleted_at, updated_at DESC);

CREATE UNIQUE INDEX workbooks_owner_source_attachment_idx
  ON workbooks(owner_email, source_attachment_id)
  WHERE source_attachment_id IS NOT NULL AND deleted_at IS NULL;

PRAGMA foreign_key_check;
