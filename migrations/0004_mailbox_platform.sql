PRAGMA defer_foreign_keys = ON;

ALTER TABLE identities ADD COLUMN signature_text TEXT NOT NULL DEFAULT '';

ALTER TABLE domains ADD COLUMN zone_id TEXT;
ALTER TABLE domains ADD COLUMN routing_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE domains ADD COLUMN sending_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE domains ADD COLUMN spf_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE domains ADD COLUMN dkim_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE domains ADD COLUMN dmarc_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE domains ADD COLUMN health_checked_at TEXT;

CREATE TABLE messages_v3 (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'archive', 'spam', 'trash')),
  delivery_status TEXT NOT NULL DEFAULT 'delivered'
    CHECK (delivery_status IN ('scheduled', 'queued', 'delivered', 'bounced', 'failed', 'cancelled', 'unknown')),
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
  html_body TEXT NOT NULL DEFAULT '',
  raw_object_key TEXT,
  raw_size_bytes INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  received_at TEXT NOT NULL,
  send_after TEXT,
  sent_at TEXT,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO messages_v3 (
  id, thread_id, domain_id, identity_id, direction, folder, delivery_status,
  internet_message_id, in_reply_to, references_json, from_name, from_email,
  to_json, cc_json, bcc_json, reply_to_email, subject, preview, text_body,
  raw_object_key, is_read, is_starred, has_attachments, received_at,
  sent_at, created_at, updated_at
)
SELECT
  id, thread_id, domain_id, identity_id, direction, folder, delivery_status,
  internet_message_id, in_reply_to, references_json, from_name, from_email,
  to_json, cc_json, bcc_json, reply_to_email, subject, preview, text_body,
  raw_object_key, is_read, is_starred, has_attachments, received_at,
  CASE WHEN direction = 'outbound' THEN received_at ELSE NULL END,
  created_at, updated_at
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_v3 RENAME TO messages;

CREATE UNIQUE INDEX messages_direction_message_id_unique
  ON messages(direction, internet_message_id)
  WHERE internet_message_id IS NOT NULL;
CREATE INDEX messages_folder_latest_idx ON messages(folder, received_at DESC, id DESC);
CREATE INDEX messages_domain_folder_latest_idx ON messages(domain_id, folder, received_at DESC, id DESC);
CREATE INDEX messages_thread_idx ON messages(thread_id, received_at ASC);
CREATE INDEX messages_in_reply_to_idx ON messages(in_reply_to);
CREATE INDEX messages_delivery_idx ON messages(direction, delivery_status, send_after);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED,
  subject,
  sender,
  recipients,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO messages_fts (message_id, subject, sender, recipients, body)
SELECT id, subject, from_name || ' ' || from_email, to_json || ' ' || cc_json, text_body
FROM messages;

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (message_id, subject, sender, recipients, body)
  VALUES (new.id, new.subject, new.from_name || ' ' || new.from_email, new.to_json || ' ' || new.cc_json, new.text_body);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, from_name, from_email, to_json, cc_json, text_body ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts (message_id, subject, sender, recipients, body)
  VALUES (new.id, new.subject, new.from_name || ' ' || new.from_email, new.to_json || ' ' || new.cc_json, new.text_body);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#64748b',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX message_labels_label_idx ON message_labels(label_id, message_id);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT
);
CREATE INDEX uploads_expiry_idx ON uploads(expires_at, claimed_at);

CREATE TABLE draft_attachments (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (draft_id, upload_id)
);

CREATE TABLE contacts (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  interaction_count INTEGER NOT NULL DEFAULT 1,
  last_contacted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX contacts_recent_idx ON contacts(last_contacted_at DESC);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_log_latest_idx ON audit_log(created_at DESC);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  undo_send_seconds INTEGER NOT NULL DEFAULT 10 CHECK (undo_send_seconds BETWEEN 0 AND 60),
  trash_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (trash_retention_days BETWEEN 1 AND 3650),
  backup_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (backup_retention_days BETWEEN 7 AND 3650),
  updated_at TEXT NOT NULL
);
INSERT INTO settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE ingest_jobs (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  header_message_id TEXT,
  raw_object_key TEXT NOT NULL UNIQUE,
  raw_size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX ingest_jobs_message_id_unique
  ON ingest_jobs(header_message_id)
  WHERE header_message_id IS NOT NULL;
CREATE INDEX ingest_jobs_status_idx ON ingest_jobs(status, updated_at);

CREATE TABLE delivery_events (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  internet_message_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX delivery_events_message_idx ON delivery_events(message_id, occurred_at DESC);

CREATE TABLE domain_health_history (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  routing_status TEXT NOT NULL,
  sending_status TEXT NOT NULL,
  spf_status TEXT NOT NULL,
  dkim_status TEXT NOT NULL,
  dmarc_status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);
CREATE INDEX domain_health_latest_idx ON domain_health_history(domain_id, checked_at DESC);

PRAGMA foreign_key_check;
