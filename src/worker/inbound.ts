import PostalMime from "postal-mime";
import type { MailJob } from "./jobs";
import {
  domainFromAddress,
  firstAddress,
  flattenAddresses,
  makePreview,
  normalizeMessageId,
  normalizeSubject,
  parseReferences,
  safeFilename,
  textFromMessage,
} from "./mail-utils";

const MAX_STORED_TEXT_LENGTH = 1_000_000;
const MAX_STORED_HTML_LENGTH = 1_000_000;

interface DomainRow {
  id: string;
  inbound_enabled: number;
}

interface IdentityRow {
  id: string;
}

interface IngestJobRow {
  id: string;
  recipient: string;
  envelope_from: string;
  header_message_id: string | null;
  raw_object_key: string;
  raw_size_bytes: number;
  status: "pending" | "processing" | "completed" | "failed";
}

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const recipient = message.to.trim().toLowerCase();
  const recipientDomain = domainFromAddress(recipient);
  if (!recipientDomain) {
    message.setReject("Invalid recipient");
    return;
  }

  const domain = await env.DB.prepare("SELECT id, inbound_enabled FROM domains WHERE name = ? AND status = 'active'")
    .bind(recipientDomain)
    .first<DomainRow>();
  if (!domain || !domain.inbound_enabled) {
    message.setReject("Mailbox is not enabled for this domain");
    return;
  }

  const headerMessageId = normalizeMessageId(message.headers.get("message-id"));
  if (headerMessageId) {
    const [stored, staged] = await Promise.all([
      env.DB.prepare("SELECT id FROM messages WHERE direction = 'inbound' AND internet_message_id = ?")
        .bind(headerMessageId)
        .first<{ id: string }>(),
      env.DB.prepare("SELECT id, status FROM ingest_jobs WHERE header_message_id = ?")
        .bind(headerMessageId)
        .first<{ id: string; status: string }>(),
    ]);
    if (stored) return;
    if (staged) {
      if (staged.status !== "completed") await env.MAIL_QUEUE.send({ type: "ingest", jobId: staged.id } satisfies MailJob);
      return;
    }
  }

  const id = crypto.randomUUID();
  const rawObjectKey = `ingest/${recipientDomain}/${id}.eml`;
  const rawMessage = await new Response(message.raw).arrayBuffer();
  const now = new Date().toISOString();

  await env.MAIL_BUCKET.put(rawObjectKey, rawMessage, {
    httpMetadata: { contentType: "message/rfc822" },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO ingest_jobs (
         id, recipient, envelope_from, header_message_id, raw_object_key,
         raw_size_bytes, status, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
      .bind(id, recipient, message.from.trim().toLowerCase(), headerMessageId, rawObjectKey, rawMessage.byteLength, now, now)
      .run();
    await env.MAIL_QUEUE.send({ type: "ingest", jobId: id } satisfies MailJob);
  } catch (error) {
    const queued = await env.DB.prepare("SELECT id FROM ingest_jobs WHERE id = ?").bind(id).first<{ id: string }>();
    if (!queued) await env.MAIL_BUCKET.delete(rawObjectKey);
    throw error;
  }
}

export async function processIngestJob(jobId: string, env: Env): Promise<void> {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 5 * 60 * 1_000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE ingest_jobs
     SET status = 'processing', attempts = attempts + 1, last_error = NULL, updated_at = ?
     WHERE id = ? AND (status IN ('pending', 'failed') OR (status = 'processing' AND updated_at < ?))`,
  ).bind(now, jobId, staleBefore).run();
  if (!claimed.meta.changes) return;

  const job = await env.DB.prepare("SELECT * FROM ingest_jobs WHERE id = ?").bind(jobId).first<IngestJobRow>();
  if (!job) return;

  try {
    const rawObject = await env.MAIL_BUCKET.get(job.raw_object_key);
    if (!rawObject) throw new Error("Staged original email is missing");
    const rawMessage = await rawObject.arrayBuffer();
    const parsed = await PostalMime.parse(rawMessage, { attachmentEncoding: "arraybuffer", maxNestingDepth: 50 });
    const internetMessageId = normalizeMessageId(parsed.messageId) || job.header_message_id;

    if (internetMessageId) {
      const duplicate = await env.DB.prepare("SELECT id FROM messages WHERE direction = 'inbound' AND internet_message_id = ?")
        .bind(internetMessageId)
        .first<{ id: string }>();
      if (duplicate) {
        await env.DB.prepare("UPDATE ingest_jobs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
          .bind(now, now, job.id)
          .run();
        await env.MAIL_BUCKET.delete(job.raw_object_key);
        return;
      }
    }

    const recipientDomain = domainFromAddress(job.recipient);
    if (!recipientDomain) throw new Error("The staged recipient domain is invalid");
    const domain = await env.DB.prepare("SELECT id, inbound_enabled FROM domains WHERE name = ? AND status = 'active'")
      .bind(recipientDomain)
      .first<DomainRow>();
    if (!domain || !domain.inbound_enabled) throw new Error("The staged recipient domain is no longer enabled");
    const identity = await env.DB.prepare("SELECT id FROM identities WHERE email = ?").bind(job.recipient).first<IdentityRow>();

    const messageId = crypto.randomUUID();
    const sender = firstAddress(parsed.from);
    const to = flattenAddresses(parsed.to);
    if (!to.some((address) => address.email === job.recipient)) to.push({ name: "", email: job.recipient });
    const cc = flattenAddresses(parsed.cc);
    const bcc = flattenAddresses(parsed.bcc);
    const replyTo = flattenAddresses(parsed.replyTo)[0]?.email || null;
    const subject = parsed.subject?.trim() || "(no subject)";
    const body = textFromMessage(parsed.text, parsed.html).slice(0, MAX_STORED_TEXT_LENGTH);
    const htmlBody = (parsed.html || "").slice(0, MAX_STORED_HTML_LENGTH);
    const references = parseReferences(parsed.references);
    const inReplyTo = normalizeMessageId(parsed.inReplyTo);
    const receivedAt = safeIsoDate(parsed.date);
    const threadId = await findThread(env.DB, inReplyTo, references);
    const resolvedThreadId = threadId || crypto.randomUUID();
    const folder = isLikelySpam(parsed.headers) ? "spam" : "inbox";

    const attachmentRows = parsed.attachments.map((attachment, index) => {
      const attachmentId = crypto.randomUUID();
      const filename = safeFilename(attachment.filename, index);
      const objectKey = `attachments/${messageId}/${attachmentId}/${encodeURIComponent(filename)}`;
      const content = attachmentContent(attachment.content);
      return {
        id: attachmentId,
        filename,
        mimeType: attachment.mimeType || "application/octet-stream",
        sizeBytes: content.byteLength,
        contentId: attachment.contentId || null,
        isInline: attachment.disposition === "inline" ? 1 : 0,
        objectKey,
        content,
      };
    });

    const uploads = await Promise.allSettled(
      attachmentRows.map((attachment) => env.MAIL_BUCKET.put(attachment.objectKey, attachment.content, {
        httpMetadata: {
          contentType: attachment.mimeType,
          contentDisposition: `${attachment.isInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        },
      })),
    );
    const uploadFailure = uploads.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (uploadFailure) {
      await Promise.allSettled(attachmentRows.map((attachment) => env.MAIL_BUCKET.delete(attachment.objectKey)));
      throw uploadFailure.reason;
    }

    const statements: D1PreparedStatement[] = [];
    if (!threadId) {
      statements.push(env.DB.prepare(
        `INSERT INTO threads (id, normalized_subject, latest_at, message_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(resolvedThreadId, normalizeSubject(subject), receivedAt, now, now));
    } else {
      statements.push(env.DB.prepare(
        `UPDATE threads SET latest_at = CASE WHEN latest_at < ? THEN ? ELSE latest_at END,
         message_count = message_count + 1, updated_at = ? WHERE id = ?`,
      ).bind(receivedAt, receivedAt, now, resolvedThreadId));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO messages (
         id, thread_id, domain_id, identity_id, direction, folder, delivery_status,
         internet_message_id, in_reply_to, references_json, from_name, from_email,
         to_json, cc_json, bcc_json, reply_to_email, subject, preview, text_body,
         html_body, raw_object_key, raw_size_bytes, is_read, is_starred,
         has_attachments, received_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'inbound', ?, 'delivered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    ).bind(
      messageId, resolvedThreadId, domain.id, identity?.id || null, folder,
      internetMessageId, inReplyTo, JSON.stringify(references), sender.name, sender.email,
      JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), replyTo, subject,
      makePreview(body), body, htmlBody, job.raw_object_key, job.raw_size_bytes,
      attachmentRows.length > 0 ? 1 : 0, receivedAt, now, now,
    ));
    for (const attachment of attachmentRows) {
      statements.push(env.DB.prepare(
        `INSERT INTO attachments (
           id, message_id, filename, mime_type, size_bytes, content_id, is_inline, object_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        attachment.id, messageId, attachment.filename, attachment.mimeType, attachment.sizeBytes,
        attachment.contentId, attachment.isInline, attachment.objectKey, now,
      ));
    }
    if (sender.email) {
      statements.push(contactStatement(env.DB, sender.email, sender.name, receivedAt));
    }
    statements.push(env.DB.prepare(
      "UPDATE ingest_jobs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
    ).bind(now, now, job.id));

    try {
      await env.DB.batch(statements);
    } catch (error) {
      await Promise.allSettled(attachmentRows.map((attachment) => env.MAIL_BUCKET.delete(attachment.objectKey)));
      throw error;
    }
  } catch (error) {
    await env.DB.prepare("UPDATE ingest_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message.slice(0, 1000) : "unknown", new Date().toISOString(), jobId)
      .run();
    throw error;
  }
}

function contactStatement(db: D1Database, email: string, name: string, timestamp: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO contacts (email, name, interaction_count, last_contacted_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END,
       interaction_count = contacts.interaction_count + 1,
       last_contacted_at = excluded.last_contacted_at,
       updated_at = excluded.updated_at`,
  ).bind(email, name, timestamp, timestamp, timestamp);
}

async function findThread(db: D1Database, inReplyTo: string | null, references: string[]): Promise<string | null> {
  const candidates = Array.from(new Set([inReplyTo, ...references].filter((value): value is string => Boolean(value)))).slice(-20);
  if (!candidates.length) return null;
  const placeholders = candidates.map(() => "?").join(",");
  const row = await db
    .prepare(`SELECT thread_id FROM messages WHERE internet_message_id IN (${placeholders}) ORDER BY received_at DESC LIMIT 1`)
    .bind(...candidates)
    .first<{ thread_id: string }>();
  return row?.thread_id || null;
}

function isLikelySpam(headers: { key: string; value: string }[] | undefined): boolean {
  if (!headers) return false;
  return headers.some(({ key, value }) => {
    const name = key.toLowerCase();
    return (name === "x-spam-flag" && /^yes$/i.test(value.trim())) ||
      (name === "x-spam-status" && /^yes\b/i.test(value.trim()));
  });
}

function attachmentContent(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return content;
}

function safeIsoDate(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}
