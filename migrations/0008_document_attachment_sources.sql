PRAGMA foreign_keys = ON;

ALTER TABLE documents
  ADD COLUMN source_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX documents_owner_source_attachment_idx
  ON documents(owner_email, source_attachment_id)
  WHERE source_attachment_id IS NOT NULL AND deleted_at IS NULL;

PRAGMA foreign_key_check;
