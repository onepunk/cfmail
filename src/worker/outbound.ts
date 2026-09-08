import { auditStatement } from "./audit";
import { plainTextToHtml } from "./mail-utils";

interface OutboundRow {
  id: string;
  identity_id: string;
  delivery_status: string;
  from_email: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_email: string | null;
  subject: string;
  text_body: string;
  html_body: string;
  in_reply_to: string | null;
  references_json: string;
  send_after: string | null;
  created_by: string | null;
}

interface AttachmentRow {
  filename: string;
  mime_type: string;
  content_id: string | null;
  is_inline: number;
  object_key: string;
}

interface StoredRecipient {
  email?: unknown;
}

const TRANSIENT_EMAIL_ERRORS = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_DELIVERY_FAILED",
]);

export async function processSendJob(messageId: string, env: Env): Promise<"sent" | "skipped"> {
  const now = new Date().toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE messages SET delivery_status = 'unknown', updated_at = ?
     WHERE id = ? AND direction = 'outbound' AND delivery_status IN ('scheduled', 'queued')
       AND (send_after IS NULL OR send_after <= ?)`,
  ).bind(now, messageId, now).run();
  if (!claimed.meta.changes) return "skipped";

  const message = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
    .bind(messageId)
    .first<OutboundRow>();
  if (!message) return "skipped";

  let acceptedByProvider = false;
  try {
    const attachmentRows = await env.DB.prepare(
      "SELECT filename, mime_type, content_id, is_inline, object_key FROM attachments WHERE message_id = ? ORDER BY created_at",
    ).bind(messageId).all<AttachmentRow>();
    const attachments = await Promise.all(attachmentRows.results.map(async (attachment): Promise<EmailAttachment> => {
      const object = await env.MAIL_BUCKET.get(attachment.object_key);
      if (!object) throw new Error(`Attachment is unavailable: ${attachment.filename}`);
      const content = await object.arrayBuffer();
      if (attachment.is_inline && attachment.content_id) {
        return {
          disposition: "inline",
          contentId: attachment.content_id,
          filename: attachment.filename,
          type: attachment.mime_type,
          content,
        };
      }
      return {
        disposition: "attachment",
        filename: attachment.filename,
        type: attachment.mime_type,
        content,
      };
    }));
    const headers: Record<string, string> = { "X-Cfmail-Message-ID": message.id };
    if (message.in_reply_to) headers["In-Reply-To"] = message.in_reply_to;
    const references = safeJson<string[]>(message.references_json, []);
    if (references.length) headers.References = references.join(" ");

    const result = await env.EMAIL.send({
      from: message.from_name ? { email: message.from_email, name: message.from_name } : message.from_email,
      replyTo: message.reply_to_email || message.from_email,
      to: recipientEmails(message.to_json),
      cc: optionalRecipients(message.cc_json),
      bcc: optionalRecipients(message.bcc_json),
      subject: message.subject,
      text: message.text_body,
      html: message.html_body || plainTextToHtml(message.text_body),
      attachments: attachments.length ? attachments : undefined,
      headers,
    });
    acceptedByProvider = true;

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE messages SET delivery_status = 'delivered', internet_message_id = ?, sent_at = ?,
         received_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND delivery_status = 'unknown'`,
      ).bind(result.messageId, now, now, now, message.id),
      env.DB.prepare(
        `INSERT INTO delivery_events (
           id, message_id, internet_message_id, event_type, status, occurred_at, created_at
         ) VALUES (?, ?, ?, 'submitted', 'delivered', ?, ?)`,
      ).bind(crypto.randomUUID(), message.id, result.messageId, now, now),
      auditStatement(env.DB, {
        actorEmail: message.created_by || env.CFMAIL_ALLOWED_USER,
        action: "message.sent",
        targetType: "message",
        targetId: message.id,
        detail: { internetMessageId: result.messageId },
      }, now),
      ...contactStatements(env.DB, message, now),
    ];
    await env.DB.batch(statements);
    return "sent";
  } catch (error) {
    const code = emailErrorCode(error);
    const detail = error instanceof Error ? error.message.slice(0, 1000) : "unknown";
    const transient = !acceptedByProvider && TRANSIENT_EMAIL_ERRORS.has(code);
    const status = acceptedByProvider ? "unknown" : transient ? "queued" : "failed";
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE messages SET delivery_status = ?, last_error = ?, updated_at = ? WHERE id = ? AND delivery_status = 'unknown'",
      ).bind(status, `${code}: ${detail}`, new Date().toISOString(), message.id),
      env.DB.prepare(
        `INSERT INTO delivery_events (
           id, message_id, event_type, status, detail, occurred_at, created_at
         ) VALUES (?, ?, 'submission', ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), message.id, acceptedByProvider ? "unknown" : transient ? "retrying" : "failed", `${code}: ${detail}`, now, now),
    ]);
    if (transient) throw error;
    return "skipped";
  }
}

function optionalRecipients(value: string): string[] | undefined {
  const addresses = recipientEmails(value);
  return addresses.length ? addresses : undefined;
}

function emailErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "E_UNKNOWN";
}

function contactStatements(db: D1Database, message: OutboundRow, now: string): D1PreparedStatement[] {
  const recipients = Array.from(new Set([
    ...recipientEmails(message.to_json),
    ...recipientEmails(message.cc_json),
    ...recipientEmails(message.bcc_json),
  ]));
  return recipients.map((email) => db.prepare(
    `INSERT INTO contacts (email, name, interaction_count, last_contacted_at, created_at, updated_at)
     VALUES (?, '', 1, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET interaction_count = contacts.interaction_count + 1,
       last_contacted_at = excluded.last_contacted_at, updated_at = excluded.updated_at`,
  ).bind(email, now, now, now));
}

export function recipientEmails(value: string): string[] {
  const recipients = safeJson<unknown[]>(value, []);
  return recipients.flatMap((recipient) => {
    if (typeof recipient === "string") return recipient.trim() ? [recipient.trim().toLowerCase()] : [];
    if (recipient && typeof recipient === "object") {
      const email = (recipient as StoredRecipient).email;
      return typeof email === "string" && email.trim() ? [email.trim().toLowerCase()] : [];
    }
    return [];
  });
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
