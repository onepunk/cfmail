ALTER TABLE drafts ADD COLUMN reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX drafts_reply_target_idx ON drafts(reply_to_message_id);

