PRAGMA foreign_keys = ON;

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL COLLATE NOCASE,
  title TEXT NOT NULL DEFAULT 'Untitled document',
  content_html TEXT NOT NULL DEFAULT '<p><br></p>',
  plain_text TEXT NOT NULL DEFAULT '',
  page_json TEXT NOT NULL DEFAULT '{"size":"letter","orientation":"portrait","margins":"normal"}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX documents_owner_updated_idx
  ON documents(owner_email, deleted_at, updated_at DESC);

PRAGMA foreign_key_check;
