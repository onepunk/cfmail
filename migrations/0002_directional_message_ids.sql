PRAGMA defer_foreign_keys = ON;

CREATE TABLE messages_v2 (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'archive', 'trash')),
  delivery_status TEXT NOT NULL DEFAULT 'delivered' CHECK (delivery_status IN ('queued', 'delivered', 'failed')),
  internet_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_email TEXT,
  subject TEXT NOT NULL DEFAULT '(no subject)',
  preview TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  raw_object_key TEXT,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO messages_v2 SELECT * FROM messages;
DROP TABLE messages;
ALTER TABLE messages_v2 RENAME TO messages;

CREATE UNIQUE INDEX messages_direction_message_id_unique
  ON messages(direction, internet_message_id)
  WHERE internet_message_id IS NOT NULL;
CREATE INDEX messages_folder_latest_idx ON messages(folder, received_at DESC);
CREATE INDEX messages_domain_folder_latest_idx ON messages(domain_id, folder, received_at DESC);
CREATE INDEX messages_thread_idx ON messages(thread_id, received_at ASC);
CREATE INDEX messages_in_reply_to_idx ON messages(in_reply_to);

PRAGMA foreign_key_check;

