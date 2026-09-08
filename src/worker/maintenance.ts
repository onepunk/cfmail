import type { MailJob } from "./jobs";

const BACKUP_TABLES = [
  "domains", "identities", "threads", "messages", "attachments", "drafts",
  "labels", "message_labels", "contacts", "settings", "audit_log", "delivery_events",
] as const;
const BACKUP_PAGE_SIZE = 500;

export async function runLogicalBackup(env: Env, requestedAt: string): Promise<void> {
  const stamp = requestedAt.replace(/[:.]/g, "-");
  const prefix = `backups/${stamp}`;
  const manifest: { createdAt: string; tables: Record<string, number>; format: number } = {
    createdAt: requestedAt,
    tables: {},
    format: 1,
  };

  for (const table of BACKUP_TABLES) {
    let offset = 0;
    let part = 0;
    let total = 0;
    while (true) {
      const result = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`)
        .bind(BACKUP_PAGE_SIZE, offset)
        .all<Record<string, unknown>>();
      if (!result.results.length) break;
      await env.MAIL_BUCKET.put(`${prefix}/${table}/${String(part).padStart(6, "0")}.json`, JSON.stringify(result.results), {
        httpMetadata: { contentType: "application/json" },
      });
      total += result.results.length;
      offset += result.results.length;
      part += 1;
      if (result.results.length < BACKUP_PAGE_SIZE) break;
    }
    manifest.tables[table] = total;
  }
  await env.MAIL_BUCKET.put(`${prefix}/manifest.json`, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function runMaintenance(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await purgeExpiredUploads(env, now);
  await purgeExpiredTrash(env, now);
  await purgeExpiredBackups(env);
  await requeueStalledIngestJobs(env, now);
  await requeueStalledSendJobs(env, now);
}

async function purgeExpiredUploads(env: Env, now: string): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, object_key FROM uploads WHERE claimed_at IS NULL AND expires_at < ? LIMIT 100",
  ).bind(now).all<{ id: string; object_key: string }>();
  await Promise.allSettled(rows.results.map((row) => env.MAIL_BUCKET.delete(row.object_key)));
  if (rows.results.length) {
    const placeholders = rows.results.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM uploads WHERE id IN (${placeholders})`).bind(...rows.results.map((row) => row.id)).run();
  }
}

async function purgeExpiredTrash(env: Env, now: string): Promise<void> {
  const setting = await env.DB.prepare("SELECT trash_retention_days FROM settings WHERE id = 1")
    .first<{ trash_retention_days: number }>();
  const cutoff = new Date(Date.now() - (setting?.trash_retention_days || 30) * 86_400_000).toISOString();
  const messages = await env.DB.prepare(
    "SELECT id, raw_object_key FROM messages WHERE folder = 'trash' AND updated_at < ? LIMIT 50",
  ).bind(cutoff).all<{ id: string; raw_object_key: string | null }>();
  for (const message of messages.results) {
    const attachments = await env.DB.prepare("SELECT object_key FROM attachments WHERE message_id = ?")
      .bind(message.id)
      .all<{ object_key: string }>();
    const keys = [...attachments.results.map((item) => item.object_key), ...(message.raw_object_key ? [message.raw_object_key] : [])];
    await Promise.allSettled(keys.map((key) => env.MAIL_BUCKET.delete(key)));
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(message.id).run();
  }
}

async function requeueStalledIngestJobs(env: Env, now: string): Promise<void> {
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id FROM ingest_jobs
     WHERE status IN ('pending', 'failed') OR (status = 'processing' AND updated_at < ?)
     ORDER BY created_at LIMIT 100`,
  ).bind(stale).all<{ id: string }>();
  if (rows.results.length) {
    await env.MAIL_QUEUE.sendBatch(rows.results.map((row) => ({ body: { type: "ingest", jobId: row.id } satisfies MailJob })));
  }
  console.log(JSON.stringify({ message: "Mailbox maintenance complete", now, requeuedIngestJobs: rows.results.length }));
}

async function requeueStalledSendJobs(env: Env, now: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, send_after FROM messages
     WHERE direction = 'outbound'
       AND created_by IS NOT NULL
       AND delivery_status IN ('scheduled', 'queued')
       AND (send_after IS NULL OR send_after <= ?)
     ORDER BY created_at LIMIT 100`,
  ).bind(now).all<{ id: string; send_after: string | null }>();
  if (!rows.results.length) return;
  await env.MAIL_QUEUE.sendBatch(rows.results.map((row) => ({ body: { type: "send", messageId: row.id } satisfies MailJob })));
}

async function purgeExpiredBackups(env: Env): Promise<void> {
  const setting = await env.DB.prepare("SELECT backup_retention_days FROM settings WHERE id = 1")
    .first<{ backup_retention_days: number }>();
  const cutoff = Date.now() - (setting?.backup_retention_days || 90) * 86_400_000;
  let cursor: string | undefined;
  do {
    const page = await env.MAIL_BUCKET.list({ prefix: "backups/", cursor, limit: 1000 });
    const expired = page.objects.filter((object) => object.uploaded.getTime() < cutoff).map((object) => object.key);
    if (expired.length) await env.MAIL_BUCKET.delete(expired);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
