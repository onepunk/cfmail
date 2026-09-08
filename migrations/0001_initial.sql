PRAGMA foreign_keys = ON;

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  inbound_enabled INTEGER NOT NULL DEFAULT 0 CHECK (inbound_enabled IN (0, 1)),
  outbound_enabled INTEGER NOT NULL DEFAULT 0 CHECK (outbound_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX identities_domain_idx ON identities(domain_id);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  normalized_subject TEXT NOT NULL,
  latest_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX threads_latest_idx ON threads(latest_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'archive', 'trash')),
  delivery_status TEXT NOT NULL DEFAULT 'delivered' CHECK (delivery_status IN ('queued', 'delivered', 'failed')),
  internet_message_id TEXT UNIQUE,
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

CREATE INDEX messages_folder_latest_idx ON messages(folder, received_at DESC);
CREATE INDEX messages_domain_folder_latest_idx ON messages(domain_id, folder, received_at DESC);
CREATE INDEX messages_thread_idx ON messages(thread_id, received_at ASC);
CREATE INDEX messages_in_reply_to_idx ON messages(in_reply_to);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0, 1)),
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX attachments_message_idx ON attachments(message_id);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX drafts_updated_idx ON drafts(updated_at DESC);

CREATE TABLE auth_attempts (
  key_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER
);

