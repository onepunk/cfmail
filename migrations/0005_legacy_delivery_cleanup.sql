-- Historical cfmail submissions were marked queued even after Email Sending
-- returned an internet message ID. Treat those as delivered so recovery jobs
-- cannot submit them a second time.
UPDATE messages
SET delivery_status = 'delivered',
    sent_at = COALESCE(sent_at, received_at),
    updated_at = CURRENT_TIMESTAMP
WHERE direction = 'outbound'
  AND delivery_status = 'queued'
  AND internet_message_id IS NOT NULL
  AND created_by IS NULL;
