import { Hono } from "hono";
import { EMAIL_VIEWER_SANDBOX } from "../shared/emailViewer";
import { z } from "zod";
import type {
  AuditRecord,
  AttachmentRecord,
  CalendarEventRecord,
  CalendarRecord,
  ContactRecord,
  DocumentPageSettings,
  DocumentRecord,
  DocumentSummary,
  DomainRecord,
  DraftRecord,
  IdentityRecord,
  IdentityRouting,
  LabelRecord,
  MailAddress,
  MessageDetail,
  MessageSummary,
  WorkbookData,
  WorkbookRecord,
  WorkbookSummary,
} from "../shared/types";
import { isSpreadsheetAttachment } from "../shared/spreadsheetAttachments";
import { prepareEmailHtml, proxyableRemoteImageUrls, safeRemoteImageUrl } from "./emailHtml";
import { isDocumentAttachment } from "../shared/documentAttachments";
import { auditStatement, writeAudit } from "./audit";
import { CloudflareApiError, RoutingConflictError, createRoutingClient } from "./routing";
import { accessLoginUrl, authenticateAccessRequest, type AccessIdentity } from "./auth";
import type { MailJob } from "./jobs";
import {
  appendHtmlSignature,
  appendTextSignature,
  decodeMessageCursor,
  domainFromAddress,
  encodeMessageCursor,
  makePreview,
  normalizeSubject,
  plainTextToHtml,
  replySubject,
  safeFilename,
} from "./mail-utils";

type Variables = { identity: AccessIdentity };
type App = { Bindings: Env; Variables: Variables };

const email = z.string().trim().toLowerCase().email().max(254);
const recipientList = z.array(email).max(50).default([]);
const attachmentIds = z.array(z.string().uuid()).max(10).default([]);
const sendSchema = z
  .object({
    identityId: z.string().uuid(),
    to: recipientList,
    cc: recipientList,
    bcc: recipientList,
    subject: z.string().max(998).default(""),
    textBody: z.string().min(1).max(500_000),
    replyToMessageId: z.string().uuid().nullable().optional(),
    confirmCrossDomain: z.boolean().default(false),
    attachmentIds,
    clientRequestId: z.string().uuid().optional(),
  })
  .refine((value) => value.to.length + value.cc.length + value.bcc.length > 0, "Add at least one recipient")
  .refine((value) => value.to.length + value.cc.length + value.bcc.length <= 50, "Use at most 50 recipients");

const draftSchema = z.object({
  id: z.string().uuid().optional(),
  identityId: z.string().uuid().nullable().default(null),
  threadId: z.string().uuid().nullable().default(null),
  replyToMessageId: z.string().uuid().nullable().default(null),
  to: recipientList,
  cc: recipientList,
  bcc: recipientList,
  subject: z.string().max(998).default(""),
  textBody: z.string().max(500_000).default(""),
  attachmentIds,
});

const documentPageSchema = z.object({
  size: z.enum(["letter", "a4"]),
  orientation: z.enum(["portrait", "landscape"]),
  margins: z.enum(["normal", "narrow", "wide"]),
});
const documentSchema = z.object({
  title: z.string().trim().max(255).default("Untitled document"),
  contentHtml: z.string().max(1_500_000).default("<p><br></p>"),
  plainText: z.string().max(500_000).default(""),
  page: documentPageSchema.default({ size: "letter", orientation: "portrait", margins: "normal" }),
});
const documentCreateSchema = documentSchema.partial().extend({
  sourceAttachmentId: z.string().uuid().nullable().optional(),
});
const spreadsheetCellStyleSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  textColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  fillColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  numberFormat: z.string().max(80).optional(),
}).strict();
const spreadsheetCellSchema = z.object({
  value: z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()]),
  formula: z.string().max(8_192).optional(),
  style: spreadsheetCellStyleSchema.optional(),
}).strict();
const spreadsheetSheetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(31),
  cells: z.record(z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,5}$/), spreadsheetCellSchema)
    .refine((cells) => Object.keys(cells).length <= 20_000, "Use at most 20,000 populated cells per sheet"),
  columnWidths: z.record(z.string().regex(/^[A-Z]{1,3}$/), z.number().int().min(40).max(500)).optional(),
}).strict();
const workbookDataSchema = z.object({
  activeSheetId: z.string().uuid(),
  sheets: z.array(spreadsheetSheetSchema).min(1).max(20),
}).strict().refine((workbook) => workbook.sheets.some((sheet) => sheet.id === workbook.activeSheetId), {
  message: "The active worksheet must exist",
  path: ["activeSheetId"],
}).refine((workbook) => new Set(workbook.sheets.map((sheet) => sheet.id)).size === workbook.sheets.length, {
  message: "Worksheet identifiers must be unique",
  path: ["sheets"],
}).refine((workbook) => new Set(workbook.sheets.map((sheet) => sheet.name.toLowerCase())).size === workbook.sheets.length, {
  message: "Worksheet names must be unique",
  path: ["sheets"],
});
const workbookSchema = z.object({
  title: z.string().trim().max(255).default("Book"),
  workbook: workbookDataSchema,
});
const workbookCreateSchema = workbookSchema.partial({ title: true }).extend({
  sourceAttachmentId: z.string().uuid().nullable().optional(),
});
const calendarColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const isoDateTime = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}, "Use an ISO date and time with a timezone offset").transform((value) => new Date(value).toISOString());
const calendarSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: calendarColor.default("#0f6cbd"),
}).strict();
const calendarEventSchema = z.object({
  calendarId: z.string().uuid(),
  title: z.string().trim().min(1).max(255),
  startAt: isoDateTime,
  endAt: isoDateTime,
  allDay: z.boolean().default(false),
  timezone: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_+\-/]+$/),
  location: z.string().trim().max(500).default(""),
  description: z.string().max(50_000).default(""),
  availability: z.enum(["free", "busy", "tentative", "out_of_office"]).default("busy"),
  recurrenceFrequency: z.enum(["none", "daily", "weekly", "monthly", "yearly"]).default("none"),
  recurrenceInterval: z.number().int().min(1).max(365).default(1),
  recurrenceUntil: isoDateTime.nullable().default(null),
  reminderMinutes: z.number().int().min(0).max(40_320).nullable().default(15),
}).strict()
  .refine((value) => Date.parse(value.endAt) > Date.parse(value.startAt), {
    message: "The event must end after it starts",
    path: ["endAt"],
  })
  .refine((value) => !value.recurrenceUntil || Date.parse(value.recurrenceUntil) >= Date.parse(value.startAt), {
    message: "Recurrence must end after the first event",
    path: ["recurrenceUntil"],
  });

export const api = new Hono<App>();

api.use("/api/*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", context.req.path.endsWith("/html") ? "SAMEORIGIN" : "DENY");
  context.header("Referrer-Policy", "no-referrer");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
});

api.use("/api/*", async (context, next) => {
  const method = context.req.method;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origin = context.req.header("Origin");
    if (!origin || origin !== new URL(context.req.url).origin) {
      return context.json({ error: "Request origin was not accepted" }, 403);
    }
  }
  await next();
});

api.use("/api/*", async (context, next) => {
  const identity = await authenticateAccessRequest(context.req.raw, context.env);
  if (!identity) {
    return context.json({ error: "Cloudflare Access authentication required", loginUrl: accessLoginUrl(context.req.url) }, 401);
  }
  context.set("identity", identity);
  await next();
});

api.get("/api/session", (context) => context.json({ authenticated: true, user: { email: context.get("identity").email } }));

api.post("/api/auth/logout", (context) => context.json({ logoutUrl: "/cdn-cgi/access/logout" }));

api.get("/api/bootstrap", async (context) => {
  const [domainResult, identityResult, unread, counts, labels, settings] = await Promise.all([
    context.env.DB.prepare(
      `SELECT id, name, label, status, inbound_enabled, outbound_enabled, zone_id,
              routing_status, sending_status, spf_status, dkim_status, dmarc_status, health_checked_at
       FROM domains ORDER BY label COLLATE NOCASE`,
    ).all<DomainRow>(),
    context.env.DB.prepare(
      `SELECT id, domain_id, email, display_name, is_default, signature_text, signature_html
       FROM identities ORDER BY is_default DESC, email COLLATE NOCASE`,
    ).all<IdentityRow>(),
    context.env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE folder = 'inbox' AND is_read = 0").first<{
      count: number;
    }>(),
    context.env.DB.prepare(
      `SELECT domain_id, folder, COUNT(*) AS total,
              SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
       FROM messages GROUP BY domain_id, folder`,
    ).all<{ domain_id: string; folder: MessageRow["folder"]; total: number; unread: number }>(),
    context.env.DB.prepare("SELECT id, name, color FROM labels ORDER BY name COLLATE NOCASE").all<LabelRow>(),
    context.env.DB.prepare(
      "SELECT undo_send_seconds, trash_retention_days, backup_retention_days FROM settings WHERE id = 1",
    ).first<{ undo_send_seconds: number; trash_retention_days: number; backup_retention_days: number }>(),
  ]);
  return context.json({
    domains: domainResult.results.map(mapDomain),
    identities: identityResult.results.map(mapIdentity),
    unreadCount: unread?.count || 0,
    counts: counts.results.map((row) => ({
      domainId: row.domain_id,
      folder: row.folder,
      total: row.total,
      unread: row.unread || 0,
    })),
    labels: labels.results.map(mapLabel),
    settings: {
      undoSendSeconds: settings?.undo_send_seconds || 10,
      trashRetentionDays: settings?.trash_retention_days || 30,
      backupRetentionDays: settings?.backup_retention_days || 90,
    },
    user: { email: context.get("identity").email },
  });
});

api.get("/api/messages", async (context) => {
  const folderValue = context.req.query("folder") || "inbox";
  if (!["inbox", "sent", "archive", "spam", "trash"].includes(folderValue)) {
    return context.json({ error: "Unknown folder" }, 400);
  }
  const domainId = context.req.query("domainId") || null;
  const query = (context.req.query("q") || "").trim().slice(0, 200);
  const sender = (context.req.query("sender") || "").trim().toLowerCase().slice(0, 254);
  const recipient = (context.req.query("recipient") || "").trim().toLowerCase().slice(0, 254);
  const dateFrom = validDateFilter(context.req.query("dateFrom"));
  const dateTo = validDateFilter(context.req.query("dateTo"));
  const attachment = context.req.query("attachment") === "true";
  const unread = context.req.query("unread") === "true";
  const starred = context.req.query("starred") === "true";
  const labelId = context.req.query("labelId") || "";
  const limit = Math.min(Math.max(Number(context.req.query("limit")) || 50, 1), 100);
  const cursorValue = context.req.query("cursor") || "";
  const cursor = cursorValue ? decodeMessageCursor(cursorValue) : null;
  if (cursorValue && !cursor) return context.json({ error: "Invalid message cursor" }, 400);
  const conditions = ["m.folder = ?"];
  const bindings: unknown[] = [folderValue];
  if (domainId) {
    conditions.push("m.domain_id = ?");
    bindings.push(domainId);
  }
  if (query) {
    conditions.push("m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)");
    bindings.push(toFtsQuery(query));
  }
  if (sender) {
    conditions.push("m.from_email LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeLike(sender)}%`);
  }
  if (recipient) {
    conditions.push("(m.to_json LIKE ? ESCAPE '\\' OR m.cc_json LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(recipient)}%`;
    bindings.push(pattern, pattern);
  }
  if (dateFrom) { conditions.push("m.received_at >= ?"); bindings.push(dateFrom); }
  if (dateTo) { conditions.push("m.received_at < ?"); bindings.push(dateTo); }
  if (attachment) conditions.push("m.has_attachments = 1");
  if (unread) conditions.push("m.is_read = 0");
  if (starred) conditions.push("m.is_starred = 1");
  if (labelId) {
    conditions.push("EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)");
    bindings.push(labelId);
  }

  const result = await context.env.DB.prepare(
    `WITH ranked AS (
       SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.received_at DESC, m.id DESC) AS thread_rank
       FROM messages m
       WHERE ${conditions.join(" AND ")}
     )
     SELECT m.id, m.thread_id, m.domain_id, m.identity_id, m.direction, m.folder,
            m.delivery_status, m.from_name, m.from_email, m.subject, m.preview,
            m.is_read, m.is_starred, m.has_attachments, m.received_at,
            m.send_after, m.last_error,
            t.message_count,
            COALESCE((
              SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
              FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id
            ), '[]') AS labels_json
     FROM ranked m
     JOIN threads t ON t.id = m.thread_id
     WHERE m.thread_rank = 1
       ${cursor ? "AND (m.received_at < ? OR (m.received_at = ? AND m.id < ?))" : ""}
     ORDER BY m.received_at DESC, m.id DESC
     LIMIT ?`,
  )
    .bind(...bindings, ...(cursor ? [cursor.receivedAt, cursor.receivedAt, cursor.id] : []), limit + 1)
    .all<MessageRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const lastRow = rows.at(-1);
  return context.json({
    messages: rows.map(mapMessage),
    hasMore,
    nextCursor: hasMore && lastRow ? encodeMessageCursor({ receivedAt: lastRow.received_at, id: lastRow.id }) : null,
  });
});

api.get("/api/messages/:id", async (context) => {
  const id = context.req.param("id");
  const current = await getMessage(context.env.DB, id);
  if (!current) return context.json({ error: "Message not found" }, 404);
  const [threadResult] = await Promise.all([
    context.env.DB.prepare(
      `SELECT m.*, t.message_count
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.thread_id = ? ORDER BY m.received_at ASC`,
    )
      .bind(current.thread_id)
      .all<MessageDetailRow>(),
    context.env.DB.prepare("UPDATE messages SET is_read = 1, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run(),
  ]);
  const thread = await Promise.all(threadResult.results.map((message) => hydrateMessage(context.env.DB, message)));
  return context.json({ message: thread.find((message) => message.id === id) || thread[0], thread });
});

api.patch("/api/messages/:id", async (context) => {
  const input = await parseBody(
    context.req.raw,
    z.object({ action: z.enum(["read", "unread", "star", "unstar", "archive", "spam", "not_spam", "trash", "restore", "cancel"]) }),
  );
  if (!input.ok) return context.json({ error: input.error }, 400);
  const actionSql: Record<typeof input.data.action, string> = {
    read: "is_read = 1",
    unread: "is_read = 0",
    star: "is_starred = 1",
    unstar: "is_starred = 0",
    archive: "folder = 'archive'",
    spam: "folder = 'spam'",
    not_spam: "folder = 'inbox'",
    trash: "folder = 'trash'",
    restore: "folder = CASE WHEN direction = 'inbound' THEN 'inbox' ELSE 'sent' END",
    cancel: "delivery_status = 'cancelled'",
  };
  const now = new Date().toISOString();
  const cancelCondition = input.data.action === "cancel" ? " AND direction = 'outbound' AND delivery_status = 'scheduled'" : "";
  const result = await context.env.DB.prepare(
    `UPDATE messages SET ${actionSql[input.data.action]}, updated_at = ? WHERE id = ?${cancelCondition}`,
  )
    .bind(now, context.req.param("id"))
    .run();
  if (!result.meta.changes) return context.json({ error: "Message not found or action is no longer available" }, 404);
  await writeAudit(context.env.DB, {
    actorEmail: context.get("identity").email,
    action: `message.${input.data.action}`,
    targetType: "message",
    targetId: context.req.param("id"),
  }, now);
  return context.json({ ok: true });
});

api.post("/api/messages/bulk", async (context) => {
  const input = await parseBody(context.req.raw, z.object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    action: z.enum(["read", "unread", "star", "unstar", "archive", "spam", "not_spam", "trash", "restore"]),
  }));
  if (!input.ok) return context.json({ error: input.error }, 400);
  const actionSql: Record<typeof input.data.action, string> = {
    read: "is_read = 1",
    unread: "is_read = 0",
    star: "is_starred = 1",
    unstar: "is_starred = 0",
    archive: "folder = 'archive'",
    spam: "folder = 'spam'",
    not_spam: "folder = 'inbox'",
    trash: "folder = 'trash'",
    restore: "folder = CASE WHEN direction = 'inbound' THEN 'inbox' ELSE 'sent' END",
  };
  const placeholders = input.data.ids.map(() => "?").join(",");
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `UPDATE messages SET ${actionSql[input.data.action]}, updated_at = ? WHERE id IN (${placeholders})`,
  ).bind(now, ...input.data.ids).run();
  await writeAudit(context.env.DB, {
    actorEmail: context.get("identity").email,
    action: `messages.bulk_${input.data.action}`,
    targetType: "message",
    detail: { ids: input.data.ids, changed: result.meta.changes || 0 },
  }, now);
  return context.json({ ok: true, changed: result.meta.changes || 0 });
});

api.delete("/api/messages/:id", async (context) => {
  const messageId = context.req.param("id");
  const row = await context.env.DB.prepare(
    "SELECT folder, raw_object_key FROM messages WHERE id = ?",
  ).bind(messageId).first<{ folder: string; raw_object_key: string | null }>();
  if (!row) return context.json({ error: "Message not found" }, 404);
  if (row.folder !== "trash") return context.json({ error: "Move the message to Trash before deleting it permanently" }, 409);
  const attachments = await context.env.DB.prepare("SELECT object_key FROM attachments WHERE message_id = ?")
    .bind(messageId)
    .all<{ object_key: string }>();
  const keys = [...attachments.results.map((item) => item.object_key), ...(row.raw_object_key ? [row.raw_object_key] : [])];
  await Promise.allSettled(keys.map((key) => context.env.MAIL_BUCKET.delete(key)));
  const now = new Date().toISOString();
  await context.env.DB.batch([
    context.env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId),
    auditStatement(context.env.DB, {
      actorEmail: context.get("identity").email,
      action: "message.deleted_permanently",
      targetType: "message",
      targetId: messageId,
    }, now),
  ]);
  return context.json({ ok: true });
});

api.get("/api/messages/:id/raw", async (context) => {
  const row = await context.env.DB.prepare("SELECT raw_object_key FROM messages WHERE id = ?")
    .bind(context.req.param("id"))
    .first<{ raw_object_key: string | null }>();
  if (!row?.raw_object_key) return context.json({ error: "Original message is unavailable" }, 404);
  const object = await context.env.MAIL_BUCKET.get(row.raw_object_key);
  if (!object) return context.json({ error: "Original message is unavailable" }, 404);
  const headers = new Headers({ "Content-Disposition": `attachment; filename="message-${context.req.param("id")}.eml"` });
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
});

api.get("/api/messages/:id/html", async (context) => {
  const row = await context.env.DB.prepare("SELECT html_body FROM messages WHERE id = ?")
    .bind(context.req.param("id"))
    .first<{ html_body: string }>();
  if (!row?.html_body) return context.json({ error: "HTML version is unavailable" }, 404);
  const nonce = crypto.randomUUID();
  const loadRemoteImages = context.req.query("remoteImages") === "1";
  const appHostname = new URL(context.req.url).hostname;
  const html = prepareEmailHtml(row.html_body, context.req.param("id"), nonce, { loadRemoteImages, blockedHostname: appHostname });
  const origin = new URL(context.req.url).origin;
  return context.body(html, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; img-src ${loadRemoteImages ? `${origin} ` : ""}data: cid:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox ${EMAIL_VIEWER_SANDBOX}`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
});

api.get("/api/messages/:id/remote-image", async (context) => {
  const requestedUrl = context.req.query("url") || "";
  const appHostname = new URL(context.req.url).hostname;
  if (requestedUrl.length > 4_096 || !safeRemoteImageUrl(requestedUrl, appHostname)) return context.json({ error: "Invalid remote image URL" }, 400);
  const row = await context.env.DB.prepare("SELECT html_body FROM messages WHERE id = ?")
    .bind(context.req.param("id"))
    .first<{ html_body: string }>();
  if (!row?.html_body) return context.json({ error: "Message image is unavailable" }, 404);
  if (!proxyableRemoteImageUrls(row.html_body, appHostname).includes(requestedUrl)) return context.json({ error: "Message image is unavailable" }, 404);

  const remote = await fetchRemoteImage(requestedUrl, appHostname);
  if (!remote.ok || !remote.body) return context.json({ error: "Remote image could not be loaded" }, 502);
  const contentType = (remote.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("image/") || contentType === "image/svg+xml") return context.json({ error: "Remote resource is not a supported image" }, 415);
  const contentLength = Number(remote.headers.get("Content-Length")) || 0;
  if (contentLength > 5_000_000) return context.json({ error: "Remote image is too large" }, 413);
  return new Response(limitResponseBody(remote.body, 5_000_000), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=86400",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

api.get("/api/attachments/:id", async (context) => {
  const row = await context.env.DB.prepare("SELECT filename, mime_type, object_key FROM attachments WHERE id = ?")
    .bind(context.req.param("id"))
    .first<{ filename: string; mime_type: string; object_key: string }>();
  if (!row) return context.json({ error: "Attachment not found" }, 404);
  const object = await context.env.MAIL_BUCKET.get(row.object_key);
  if (!object) return context.json({ error: "Attachment not found" }, 404);
  const headers = new Headers({
    "Content-Type": row.mime_type,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    "X-Content-Type-Options": "nosniff",
  });
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
});

api.get("/api/attachments/:id/document", async (context) => {
  const ownerEmail = context.get("identity").email;
  const row = await context.env.DB.prepare(
    `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.is_inline,
            (SELECT d.id FROM documents d
             WHERE d.owner_email = ?1 AND d.source_attachment_id = a.id AND d.deleted_at IS NULL
             LIMIT 1) AS document_id
     FROM attachments a WHERE a.id = ?2`,
  ).bind(ownerEmail, context.req.param("id")).first<AttachmentDocumentRow>();
  if (!row) return context.json({ error: "Attachment not found" }, 404);
  if (!isDocumentAttachment({ filename: row.filename, mimeType: row.mime_type })) {
    return context.json({ error: "Only .docx attachments can be opened in cfmail Documents" }, 415);
  }
  return context.json({
    attachment: mapAttachment(row),
    documentId: row.document_id,
  });
});

api.get("/api/attachments/:id/spreadsheet", async (context) => {
  const ownerEmail = context.get("identity").email;
  const row = await context.env.DB.prepare(
    `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.is_inline,
            (SELECT w.id FROM workbooks w
             WHERE w.owner_email = ?1 AND w.source_attachment_id = a.id AND w.deleted_at IS NULL
             LIMIT 1) AS workbook_id
     FROM attachments a WHERE a.id = ?2`,
  ).bind(ownerEmail, context.req.param("id")).first<AttachmentWorkbookRow>();
  if (!row) return context.json({ error: "Attachment not found" }, 404);
  if (!isSpreadsheetAttachment({ filename: row.filename, mimeType: row.mime_type })) {
    return context.json({ error: "Only .xlsx attachments can be opened in cfmail Spreadsheets" }, 415);
  }
  return context.json({
    attachment: mapAttachment(row),
    workbookId: row.workbook_id,
  });
});

api.post("/api/uploads", async (context) => {
  const contentType = context.req.header("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return context.json({ error: "Use multipart form data for attachments" }, 415);
  }
  const form = await context.req.raw.formData();
  const files = form.getAll("files").filter((value): value is File => value instanceof File);
  if (!files.length || files.length > 10) return context.json({ error: "Attach between 1 and 10 files" }, 400);
  const totalSize = files.reduce((total, file) => total + file.size, 0);
  if (totalSize > 20 * 1024 * 1024) return context.json({ error: "Attachments must total 20 MiB or less" }, 413);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  const rows: UploadRow[] = files.map((file, index) => {
    const id = crypto.randomUUID();
    const filename = safeFilename(file.name, index);
    return {
      id,
      filename,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      object_key: `uploads/${id}/${encodeURIComponent(filename)}`,
    };
  });
  const uploaded: string[] = [];
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      await context.env.MAIL_BUCKET.put(row.object_key, await files[index].arrayBuffer(), {
        httpMetadata: {
          contentType: row.mime_type,
          contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        },
      });
      uploaded.push(row.object_key);
    }
    await context.env.DB.batch(rows.map((row) => context.env.DB.prepare(
      `INSERT INTO uploads (
         id, filename, mime_type, size_bytes, object_key, created_by, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id, row.filename, row.mime_type, row.size_bytes, row.object_key,
      context.get("identity").email, now, expiresAt,
    )));
  } catch (error) {
    await Promise.allSettled(uploaded.map((key) => context.env.MAIL_BUCKET.delete(key)));
    throw error;
  }
  return context.json({
    uploads: rows.map((row) => ({ id: row.id, filename: row.filename, mimeType: row.mime_type, sizeBytes: row.size_bytes })),
  }, 201);
});

api.post("/api/messages/send", async (context) => {
  const input = await parseBody(context.req.raw, sendSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const identity = await context.env.DB.prepare(
    `SELECT i.id, i.domain_id, i.email, i.display_name, i.signature_text, i.signature_html,
            d.outbound_enabled, d.status
     FROM identities i JOIN domains d ON d.id = i.domain_id WHERE i.id = ?`,
  )
    .bind(input.data.identityId)
    .first<SendIdentityRow>();
  if (!identity || identity.status !== "active" || !identity.outbound_enabled) {
    return context.json({ error: "This sending identity is not enabled" }, 409);
  }

  const messageId = input.data.clientRequestId || crypto.randomUUID();
  const existing = await context.env.DB.prepare(
    "SELECT id, thread_id, delivery_status, send_after FROM messages WHERE id = ? AND direction = 'outbound'",
  ).bind(messageId).first<{ id: string; thread_id: string; delivery_status: string; send_after: string | null }>();
  if (existing) {
    if (existing.delivery_status === "scheduled" || existing.delivery_status === "queued") {
      const delaySeconds = Math.max(0, Math.ceil((Date.parse(existing.send_after || new Date().toISOString()) - Date.now()) / 1_000));
      await context.env.MAIL_QUEUE.send({ type: "send", messageId } satisfies MailJob, { delaySeconds });
    }
    return context.json({ id: existing.id, threadId: existing.thread_id, status: existing.delivery_status }, 202);
  }

  let replyTarget: ReplyTargetRow | null = null;
  if (input.data.replyToMessageId) {
    replyTarget = await context.env.DB.prepare(
      "SELECT id, thread_id, domain_id, internet_message_id, references_json, subject FROM messages WHERE id = ?",
    )
      .bind(input.data.replyToMessageId)
      .first<ReplyTargetRow>();
    if (!replyTarget) return context.json({ error: "The message being replied to no longer exists" }, 409);
    if (replyTarget.domain_id !== identity.domain_id && !input.data.confirmCrossDomain) {
      return context.json(
        { error: "Confirm the sending identity because it belongs to a different domain", code: "cross_domain_identity" },
        409,
      );
    }
  }

  const references = replyTarget
    ? Array.from(
        new Set([
          ...safeJson<string[]>(replyTarget.references_json, []),
          ...(replyTarget.internet_message_id ? [replyTarget.internet_message_id] : []),
        ]),
      ).slice(-100)
    : [];
  const subject = replyTarget ? replySubject(input.data.subject || replyTarget.subject) : input.data.subject || "(no subject)";
  const now = new Date().toISOString();
  const settings = await context.env.DB.prepare("SELECT undo_send_seconds FROM settings WHERE id = 1")
    .first<{ undo_send_seconds: number }>();
  const undoSendSeconds = settings?.undo_send_seconds ?? 10;
  const sendAfter = new Date(Date.now() + undoSendSeconds * 1_000).toISOString();
  const threadId = replyTarget?.thread_id || crypto.randomUUID();
  const textBody = appendTextSignature(input.data.textBody, identity.signature_text);
  const htmlBody = identity.signature_html.trim()
    ? appendHtmlSignature(plainTextToHtml(input.data.textBody), identity.signature_html)
    : plainTextToHtml(textBody);
  const uploads = input.data.attachmentIds.length
    ? await context.env.DB.prepare(
        `SELECT id, filename, mime_type, size_bytes, object_key FROM uploads
         WHERE id IN (${input.data.attachmentIds.map(() => "?").join(",")})
           AND created_by = ? AND claimed_at IS NULL`,
      ).bind(...input.data.attachmentIds, context.get("identity").email).all<UploadRow>()
    : { results: [] as UploadRow[] };
  if (uploads.results.length !== input.data.attachmentIds.length) {
    return context.json({ error: "One or more attachments are unavailable" }, 409);
  }
  const statements: D1PreparedStatement[] = [];
  if (!replyTarget) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO threads (id, normalized_subject, latest_at, message_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(threadId, normalizeSubject(subject), now, now, now),
    );
  } else {
    statements.push(
      context.env.DB.prepare(
        "UPDATE threads SET latest_at = ?, message_count = message_count + 1, updated_at = ? WHERE id = ?",
      ).bind(now, now, threadId),
    );
  }
  statements.push(
    context.env.DB.prepare(
      `INSERT INTO messages (
         id, thread_id, domain_id, identity_id, direction, folder, delivery_status,
         internet_message_id, in_reply_to, references_json, from_name, from_email,
         to_json, cc_json, bcc_json, reply_to_email, subject, preview, text_body, html_body,
         is_read, is_starred, has_attachments, received_at, send_after, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'outbound', 'sent', 'scheduled', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      messageId,
      threadId,
      identity.domain_id,
      identity.id,
      replyTarget?.internet_message_id || null,
      JSON.stringify(references),
      identity.display_name,
      identity.email,
      JSON.stringify(toMailAddresses(input.data.to)),
      JSON.stringify(toMailAddresses(input.data.cc)),
      JSON.stringify(toMailAddresses(input.data.bcc)),
      identity.email,
      subject,
      makePreview(textBody),
      textBody,
      htmlBody,
      uploads.results.length ? 1 : 0,
      now,
      sendAfter,
      context.get("identity").email,
      now,
      now,
    ),
  );
  for (const upload of uploads.results) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO attachments (
           id, message_id, filename, mime_type, size_bytes, content_id, is_inline, object_key, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      ).bind(crypto.randomUUID(), messageId, upload.filename, upload.mime_type, upload.size_bytes, upload.object_key, now),
      context.env.DB.prepare("UPDATE uploads SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL").bind(now, upload.id),
    );
  }
  statements.push(auditStatement(context.env.DB, {
    actorEmail: context.get("identity").email,
    action: "message.scheduled",
    targetType: "message",
    targetId: messageId,
    detail: { sendAfter, attachmentCount: uploads.results.length },
  }, now));
  await context.env.DB.batch(statements);
  await context.env.MAIL_QUEUE.send({ type: "send", messageId } satisfies MailJob, { delaySeconds: undoSendSeconds });
  return context.json({ id: messageId, threadId, status: "scheduled", sendAfter }, 202);
});

api.get("/api/drafts", async (context) => {
  const rows = await context.env.DB.prepare("SELECT * FROM drafts ORDER BY updated_at DESC").all<DraftRow>();
  const drafts = await Promise.all(rows.results.map(async (row) => {
    const attachments = await context.env.DB.prepare(
      "SELECT upload_id FROM draft_attachments WHERE draft_id = ? ORDER BY created_at",
    ).bind(row.id).all<{ upload_id: string }>();
    return mapDraft(row, attachments.results.map((attachment) => attachment.upload_id));
  }));
  return context.json({ drafts });
});

api.put("/api/drafts", async (context) => {
  const input = await parseBody(context.req.raw, draftSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const id = input.data.id || crypto.randomUUID();
  const now = new Date().toISOString();
  const uploads = input.data.attachmentIds.length
    ? await context.env.DB.prepare(
        `SELECT id FROM uploads WHERE id IN (${input.data.attachmentIds.map(() => "?").join(",")})
         AND created_by = ? AND claimed_at IS NULL`,
      ).bind(...input.data.attachmentIds, context.get("identity").email).all<{ id: string }>()
    : { results: [] as { id: string }[] };
  if (uploads.results.length !== input.data.attachmentIds.length) {
    return context.json({ error: "One or more draft attachments are unavailable" }, 409);
  }
  const statements: D1PreparedStatement[] = [context.env.DB.prepare(
    `INSERT INTO drafts (id, identity_id, thread_id, reply_to_message_id, to_json, cc_json, bcc_json, subject, text_body, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       identity_id = excluded.identity_id, thread_id = excluded.thread_id,
       reply_to_message_id = excluded.reply_to_message_id,
       to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json,
       subject = excluded.subject, text_body = excluded.text_body, updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      input.data.identityId,
      input.data.threadId,
      input.data.replyToMessageId,
      JSON.stringify(input.data.to),
      JSON.stringify(input.data.cc),
      JSON.stringify(input.data.bcc),
      input.data.subject,
      input.data.textBody,
      now,
      now,
    ), context.env.DB.prepare("DELETE FROM draft_attachments WHERE draft_id = ?").bind(id)];
  for (const upload of uploads.results) {
    statements.push(context.env.DB.prepare(
      "INSERT INTO draft_attachments (draft_id, upload_id, created_at) VALUES (?, ?, ?)",
    ).bind(id, upload.id, now));
  }
  await context.env.DB.batch(statements);
  return context.json({ id, updatedAt: now });
});

api.delete("/api/drafts/:id", async (context) => {
  await context.env.DB.prepare("DELETE FROM drafts WHERE id = ?").bind(context.req.param("id")).run();
  await writeAudit(context.env.DB, {
    actorEmail: context.get("identity").email,
    action: "draft.deleted",
    targetType: "draft",
    targetId: context.req.param("id"),
  });
  return context.json({ ok: true });
});

api.post("/api/domains", async (context) => {
  const input = await parseBody(
    context.req.raw,
    z.object({
      name: z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
      label: z.string().trim().min(1).max(80),
      inboundEnabled: z.boolean().default(false),
      outboundEnabled: z.boolean().default(false),
    }),
  );
  if (!input.ok) return context.json({ error: input.error }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await context.env.DB.prepare(
      `INSERT INTO domains (id, name, label, inbound_enabled, outbound_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.data.name,
        input.data.label,
        input.data.inboundEnabled ? 1 : 0,
        input.data.outboundEnabled ? 1 : 0,
        now,
        now,
      )
      .run();
    await writeAudit(context.env.DB, {
      actorEmail: context.get("identity").email,
      action: "domain.created",
      targetType: "domain",
      targetId: id,
      detail: { name: input.data.name },
    }, now);
    return context.json({ id }, 201);
  } catch {
    return context.json({ error: "That domain is already configured" }, 409);
  }
});

api.post("/api/identities", async (context) => {
  const input = await parseBody(
    context.req.raw,
    z.object({
      domainId: z.string().uuid(),
      email,
      displayName: z.string().trim().max(100).default(""),
      isDefault: z.boolean(),
      signatureText: z.string().max(10_000).default(""),
      signatureHtml: z.string().max(50_000).default(""),
    }),
  );
  if (!input.ok) return context.json({ error: input.error }, 400);
  const domain = await context.env.DB.prepare("SELECT name, inbound_enabled, zone_id FROM domains WHERE id = ?")
    .bind(input.data.domainId)
    .first<{ name: string; inbound_enabled: number; zone_id: string | null }>();
  if (!domain) return context.json({ error: "Domain not found" }, 404);
  if (domainFromAddress(input.data.email) !== domain.name) {
    return context.json({ error: "The identity must use the selected domain" }, 400);
  }
  const duplicate = await context.env.DB.prepare("SELECT id FROM identities WHERE email = ?")
    .bind(input.data.email)
    .first<{ id: string }>();
  if (duplicate) return context.json({ error: "That email identity is already configured" }, 409);

  let routing: IdentityRouting = "not_configured";
  let createdRule: { zoneId: string; ruleId: string } | null = null;
  const routingClient = context.env.CF_API_TOKEN ? createRoutingClient({ apiToken: context.env.CF_API_TOKEN }) : null;
  if (!domain.inbound_enabled) {
    routing = "inbound_disabled";
  } else if (routingClient) {
    try {
      const route = await routingClient.ensureWorkerRoute({
        domain: domain.name,
        address: input.data.email,
        workerName: context.env.CFMAIL_WORKER_NAME || "cfmail",
        zoneId: domain.zone_id,
      });
      routing = route.status;
      if (route.status === "created") createdRule = { zoneId: route.zoneId, ruleId: route.ruleId };
      if (route.zoneId !== domain.zone_id) {
        await context.env.DB.prepare("UPDATE domains SET zone_id = ? WHERE id = ?").bind(route.zoneId, input.data.domainId).run();
      }
    } catch (caught) {
      if (caught instanceof RoutingConflictError) return context.json({ error: caught.message }, 409);
      if (caught instanceof CloudflareApiError) {
        return context.json({ error: `Could not create the Email Routing rule. ${caught.message}` }, 502);
      }
      throw caught;
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (input.data.isDefault) statements.push(context.env.DB.prepare("UPDATE identities SET is_default = 0"));
  statements.push(
    context.env.DB.prepare(
      `INSERT INTO identities (
         id, domain_id, email, display_name, is_default, signature_text, signature_html, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, input.data.domainId, input.data.email, input.data.displayName,
      input.data.isDefault ? 1 : 0, input.data.signatureText, input.data.signatureHtml, now, now,
    ),
    auditStatement(context.env.DB, {
      actorEmail: context.get("identity").email,
      action: "identity.created",
      targetType: "identity",
      targetId: id,
      detail: { email: input.data.email, routing },
    }, now),
  );
  try {
    await context.env.DB.batch(statements);
    return context.json({ id, routing }, 201);
  } catch {
    if (createdRule && routingClient) {
      await routingClient.deleteRule(createdRule.zoneId, createdRule.ruleId).catch(() => undefined);
    }
    return context.json({ error: "That email identity is already configured" }, 409);
  }
});

api.patch("/api/identities/:id", async (context) => {
  const input = await parseBody(context.req.raw, z.object({
    displayName: z.string().trim().max(100),
    signatureText: z.string().max(10_000),
    signatureHtml: z.string().max(50_000),
    isDefault: z.boolean(),
  }));
  if (!input.ok) return context.json({ error: input.error }, 400);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (input.data.isDefault) statements.push(context.env.DB.prepare("UPDATE identities SET is_default = 0"));
  statements.push(
    context.env.DB.prepare(
      `UPDATE identities
       SET display_name = ?, signature_text = ?, signature_html = ?, is_default = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      input.data.displayName,
      input.data.signatureText,
      input.data.signatureHtml,
      input.data.isDefault ? 1 : 0,
      now,
      context.req.param("id"),
    ),
    auditStatement(context.env.DB, {
      actorEmail: context.get("identity").email,
      action: "identity.updated",
      targetType: "identity",
      targetId: context.req.param("id"),
    }, now),
  );
  const results = await context.env.DB.batch(statements);
  if (!results.some((result) => result.meta.changes)) return context.json({ error: "Identity not found" }, 404);
  return context.json({ ok: true });
});

api.post("/api/domains/:id/health", async (context) => {
  const domain = await context.env.DB.prepare("SELECT id, name FROM domains WHERE id = ?")
    .bind(context.req.param("id"))
    .first<{ id: string; name: string }>();
  if (!domain) return context.json({ error: "Domain not found" }, 404);
  const health = await checkDomainHealth(domain.name);
  const now = new Date().toISOString();
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE domains SET routing_status = ?, sending_status = ?, spf_status = ?, dkim_status = ?,
       dmarc_status = ?, health_checked_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(health.routing, health.sending, health.spf, health.dkim, health.dmarc, now, now, domain.id),
    context.env.DB.prepare(
      `INSERT INTO domain_health_history (
         id, domain_id, routing_status, sending_status, spf_status, dkim_status, dmarc_status, detail_json, checked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), domain.id, health.routing, health.sending, health.spf,
      health.dkim, health.dmarc, JSON.stringify(health.detail), now,
    ),
    auditStatement(context.env.DB, {
      actorEmail: context.get("identity").email,
      action: "domain.health_checked",
      targetType: "domain",
      targetId: domain.id,
    }, now),
  ]);
  return context.json({ health: { ...health, checkedAt: now } });
});

api.get("/api/domains/:id/storage", async (context) => {
  const row = await context.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE domain_id = ?) AS messages,
       (SELECT COALESCE(SUM(raw_size_bytes), 0) FROM messages WHERE domain_id = ?) AS raw_bytes,
       (SELECT COALESCE(SUM(a.size_bytes), 0) FROM attachments a
        JOIN messages m ON m.id = a.message_id WHERE m.domain_id = ?) AS attachment_bytes`,
  ).bind(context.req.param("id"), context.req.param("id"), context.req.param("id"))
    .first<{ messages: number; raw_bytes: number; attachment_bytes: number }>();
  return context.json({
    messages: row?.messages || 0,
    rawBytes: row?.raw_bytes || 0,
    attachmentBytes: row?.attachment_bytes || 0,
  });
});

api.get("/api/contacts", async (context) => {
  const query = (context.req.query("q") || "").trim().toLowerCase().slice(0, 100);
  const pattern = `%${escapeLike(query)}%`;
  const result = await context.env.DB.prepare(
    `SELECT email, name, interaction_count, last_contacted_at FROM contacts
     WHERE ? = '' OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
     ORDER BY interaction_count DESC, last_contacted_at DESC LIMIT 20`,
  ).bind(query, pattern, pattern).all<ContactRow>();
  const contacts: ContactRecord[] = result.results.map((row) => ({
    email: row.email,
    name: row.name,
    interactionCount: row.interaction_count,
    lastContactedAt: row.last_contacted_at,
  }));
  return context.json({ contacts });
});

api.post("/api/labels", async (context) => {
  const input = await parseBody(context.req.raw, z.object({
    name: z.string().trim().min(1).max(50),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#64748b"),
  }));
  if (!input.ok) return context.json({ error: input.error }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO labels (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, input.data.name, input.data.color, now, now),
      auditStatement(context.env.DB, {
        actorEmail: context.get("identity").email,
        action: "label.created",
        targetType: "label",
        targetId: id,
      }, now),
    ]);
    return context.json({ id }, 201);
  } catch {
    return context.json({ error: "A label with that name already exists" }, 409);
  }
});

api.put("/api/messages/:id/labels", async (context) => {
  const input = await parseBody(context.req.raw, z.object({ labelIds: z.array(z.string().uuid()).max(50) }));
  if (!input.ok) return context.json({ error: input.error }, 400);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare("DELETE FROM message_labels WHERE message_id = ?").bind(context.req.param("id")),
  ];
  for (const labelId of input.data.labelIds) {
    statements.push(context.env.DB.prepare(
      "INSERT INTO message_labels (message_id, label_id, created_at) VALUES (?, ?, ?)",
    ).bind(context.req.param("id"), labelId, now));
  }
  statements.push(auditStatement(context.env.DB, {
    actorEmail: context.get("identity").email,
    action: "message.labels_updated",
    targetType: "message",
    targetId: context.req.param("id"),
    detail: { labelIds: input.data.labelIds },
  }, now));
  await context.env.DB.batch(statements);
  return context.json({ ok: true });
});

api.get("/api/audit", async (context) => {
  const result = await context.env.DB.prepare(
    "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200",
  ).all<AuditRow>();
  const entries: AuditRecord[] = result.results.map((row) => ({
    id: row.id,
    actorEmail: row.actor_email,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: safeJson<Record<string, unknown>>(row.detail_json, {}),
    createdAt: row.created_at,
  }));
  return context.json({ entries });
});

api.get("/api/delivery/summary", async (context) => {
  const [statusRows, recentRows] = await Promise.all([
    context.env.DB.prepare(
      "SELECT domain_id, delivery_status, COUNT(*) AS count FROM messages WHERE direction = 'outbound' GROUP BY domain_id, delivery_status",
    ).all<{ domain_id: string; delivery_status: string; count: number }>(),
    context.env.DB.prepare(
      `SELECT de.*, m.subject, m.from_email FROM delivery_events de
       LEFT JOIN messages m ON m.id = de.message_id ORDER BY de.occurred_at DESC LIMIT 100`,
    ).all<DeliveryEventRow>(),
  ]);
  return context.json({
    summary: statusRows.results.map((row) => ({ domainId: row.domain_id, status: row.delivery_status, count: row.count })),
    recent: recentRows.results.map((row) => ({
      id: row.id, messageId: row.message_id, subject: row.subject || "", fromEmail: row.from_email || "",
      eventType: row.event_type, status: row.status, detail: row.detail, occurredAt: row.occurred_at,
    })),
  });
});

api.patch("/api/settings", async (context) => {
  const input = await parseBody(context.req.raw, z.object({
    undoSendSeconds: z.number().int().min(0).max(60),
    trashRetentionDays: z.number().int().min(1).max(3650),
    backupRetentionDays: z.number().int().min(7).max(3650),
  }));
  if (!input.ok) return context.json({ error: input.error }, 400);
  const now = new Date().toISOString();
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE settings SET undo_send_seconds = ?, trash_retention_days = ?,
       backup_retention_days = ?, updated_at = ? WHERE id = 1`,
    ).bind(input.data.undoSendSeconds, input.data.trashRetentionDays, input.data.backupRetentionDays, now),
    auditStatement(context.env.DB, {
      actorEmail: context.get("identity").email,
      action: "settings.updated",
      targetType: "settings",
      targetId: "1",
    }, now),
  ]);
  return context.json({ ok: true });
});

api.get("/api/documents", async (context) => {
  const ownerEmail = context.get("identity").email;
  const result = await context.env.DB.prepare(
    `SELECT id, title, plain_text, created_at, updated_at
     FROM documents
     WHERE owner_email = ?1 AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 200`,
  ).bind(ownerEmail).all<DocumentSummaryRow>();
  return context.json({ documents: result.results.map(mapDocumentSummary) });
});

api.post("/api/documents", async (context) => {
  const input = await parseBody(context.req.raw, documentCreateSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const { sourceAttachmentId = null, ...documentInput } = input.data;
  const data = documentSchema.parse(documentInput);
  const ownerEmail = context.get("identity").email;
  if (sourceAttachmentId) {
    const attachment = await context.env.DB.prepare(
      "SELECT filename, mime_type FROM attachments WHERE id = ?1",
    ).bind(sourceAttachmentId).first<{ filename: string; mime_type: string }>();
    if (!attachment) return context.json({ error: "Attachment not found" }, 404);
    if (!isDocumentAttachment({ filename: attachment.filename, mimeType: attachment.mime_type })) {
      return context.json({ error: "Only .docx attachments can be imported" }, 415);
    }
    const existing = await documentForSourceAttachment(context.env.DB, ownerEmail, sourceAttachmentId);
    if (existing) return context.json({ document: mapDocument(existing), reused: true });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO documents
         (id, owner_email, title, content_html, plain_text, page_json, source_attachment_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      ).bind(id, ownerEmail, data.title || "Untitled document", data.contentHtml, data.plainText, JSON.stringify(data.page), sourceAttachmentId, now),
      auditStatement(context.env.DB, {
        actorEmail: ownerEmail,
        action: sourceAttachmentId ? "document.created_from_attachment" : "document.created",
        targetType: "document",
        targetId: id,
        detail: sourceAttachmentId ? { sourceAttachmentId } : undefined,
      }, now),
    ]);
  } catch (error) {
    if (sourceAttachmentId) {
      const existing = await documentForSourceAttachment(context.env.DB, ownerEmail, sourceAttachmentId);
      if (existing) return context.json({ document: mapDocument(existing), reused: true });
    }
    throw error;
  }
  const row = await context.env.DB.prepare(
    `SELECT id, title, content_html, plain_text, page_json, created_at, updated_at
     FROM documents WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL`,
  ).bind(id, ownerEmail).first<DocumentRow>();
  if (!row) return context.json({ error: "Document could not be created" }, 500);
  return context.json({ document: mapDocument(row), reused: false }, 201);
});

api.get("/api/documents/:id", async (context) => {
  const row = await context.env.DB.prepare(
    `SELECT id, title, content_html, plain_text, page_json, created_at, updated_at
     FROM documents WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL`,
  ).bind(context.req.param("id"), context.get("identity").email).first<DocumentRow>();
  if (!row) return context.json({ error: "Document not found" }, 404);
  return context.json({ document: mapDocument(row) });
});

api.put("/api/documents/:id", async (context) => {
  const input = await parseBody(context.req.raw, documentSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `UPDATE documents
     SET title = ?1, content_html = ?2, plain_text = ?3, page_json = ?4, updated_at = ?5
     WHERE id = ?6 AND owner_email = ?7 AND deleted_at IS NULL`,
  ).bind(
    input.data.title || "Untitled document",
    input.data.contentHtml,
    input.data.plainText,
    JSON.stringify(input.data.page),
    now,
    context.req.param("id"),
    context.get("identity").email,
  ).run();
  if (!result.meta.changes) return context.json({ error: "Document not found" }, 404);
  return context.json({ updatedAt: now });
});

api.delete("/api/documents/:id", async (context) => {
  const ownerEmail = context.get("identity").email;
  const id = context.req.param("id");
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    "UPDATE documents SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND owner_email = ?3 AND deleted_at IS NULL",
  ).bind(now, id, ownerEmail).run();
  if (!result.meta.changes) return context.json({ error: "Document not found" }, 404);
  await writeAudit(context.env.DB, {
    actorEmail: ownerEmail,
    action: "document.deleted",
    targetType: "document",
    targetId: id,
  }, now);
  return context.json({ ok: true });
});

api.get("/api/workbooks", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT id, title, preview, sheet_count, cell_count, created_at, updated_at
     FROM workbooks
     WHERE owner_email = ?1 AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 200`,
  ).bind(context.get("identity").email).all<WorkbookSummaryRow>();
  return context.json({ workbooks: result.results.map(mapWorkbookSummary) });
});

api.post("/api/workbooks", async (context) => {
  const input = await parseBody(context.req.raw, workbookCreateSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const { sourceAttachmentId = null, ...workbookInput } = input.data;
  const data = workbookSchema.parse(workbookInput);
  const serialized = JSON.stringify(data.workbook);
  if (serialized.length > 1_500_000) return context.json({ error: "Workbook is too large to save" }, 413);
  const ownerEmail = context.get("identity").email;
  if (sourceAttachmentId) {
    const attachment = await context.env.DB.prepare(
      "SELECT filename, mime_type FROM attachments WHERE id = ?1",
    ).bind(sourceAttachmentId).first<{ filename: string; mime_type: string }>();
    if (!attachment) return context.json({ error: "Attachment not found" }, 404);
    if (!isSpreadsheetAttachment({ filename: attachment.filename, mimeType: attachment.mime_type })) {
      return context.json({ error: "Only .xlsx attachments can be imported" }, 415);
    }
    const existing = await workbookForSourceAttachment(context.env.DB, ownerEmail, sourceAttachmentId);
    if (existing) return context.json({ workbook: mapWorkbook(existing), reused: true });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const stats = workbookStats(data.workbook);
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO workbooks
         (id, owner_email, title, workbook_json, preview, sheet_count, cell_count,
          source_attachment_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      ).bind(id, ownerEmail, data.title || "Book", serialized, stats.preview, stats.sheetCount, stats.cellCount, sourceAttachmentId, now),
      auditStatement(context.env.DB, {
        actorEmail: ownerEmail,
        action: sourceAttachmentId ? "workbook.created_from_attachment" : "workbook.created",
        targetType: "workbook",
        targetId: id,
        detail: sourceAttachmentId ? { sourceAttachmentId } : undefined,
      }, now),
    ]);
  } catch (error) {
    if (sourceAttachmentId) {
      const existing = await workbookForSourceAttachment(context.env.DB, ownerEmail, sourceAttachmentId);
      if (existing) return context.json({ workbook: mapWorkbook(existing), reused: true });
    }
    throw error;
  }
  const row = await context.env.DB.prepare(
    `SELECT id, title, workbook_json, preview, sheet_count, cell_count, created_at, updated_at
     FROM workbooks WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL`,
  ).bind(id, ownerEmail).first<WorkbookRow>();
  if (!row) return context.json({ error: "Workbook could not be created" }, 500);
  return context.json({ workbook: mapWorkbook(row), reused: false }, 201);
});

api.get("/api/workbooks/:id", async (context) => {
  const row = await context.env.DB.prepare(
    `SELECT id, title, workbook_json, preview, sheet_count, cell_count, created_at, updated_at
     FROM workbooks WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL`,
  ).bind(context.req.param("id"), context.get("identity").email).first<WorkbookRow>();
  if (!row) return context.json({ error: "Workbook not found" }, 404);
  return context.json({ workbook: mapWorkbook(row) });
});

api.put("/api/workbooks/:id", async (context) => {
  const input = await parseBody(context.req.raw, workbookSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const serialized = JSON.stringify(input.data.workbook);
  if (serialized.length > 1_500_000) return context.json({ error: "Workbook is too large to save" }, 413);
  const stats = workbookStats(input.data.workbook);
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `UPDATE workbooks
     SET title = ?1, workbook_json = ?2, preview = ?3, sheet_count = ?4, cell_count = ?5, updated_at = ?6
     WHERE id = ?7 AND owner_email = ?8 AND deleted_at IS NULL`,
  ).bind(
    input.data.title || "Book",
    serialized,
    stats.preview,
    stats.sheetCount,
    stats.cellCount,
    now,
    context.req.param("id"),
    context.get("identity").email,
  ).run();
  if (!result.meta.changes) return context.json({ error: "Workbook not found" }, 404);
  return context.json({ updatedAt: now });
});

api.delete("/api/workbooks/:id", async (context) => {
  const ownerEmail = context.get("identity").email;
  const id = context.req.param("id");
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    "UPDATE workbooks SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND owner_email = ?3 AND deleted_at IS NULL",
  ).bind(now, id, ownerEmail).run();
  if (!result.meta.changes) return context.json({ error: "Workbook not found" }, 404);
  await writeAudit(context.env.DB, {
    actorEmail: ownerEmail,
    action: "workbook.deleted",
    targetType: "workbook",
    targetId: id,
  }, now);
  return context.json({ ok: true });
});

api.get("/api/calendars", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT id, name, color, is_default, created_at, updated_at
     FROM calendars
     WHERE owner_email = ?1 AND deleted_at IS NULL
     ORDER BY is_default DESC, name COLLATE NOCASE`,
  ).bind(context.get("identity").email).all<CalendarRow>();
  return context.json({ calendars: result.results.map(mapCalendar) });
});

api.post("/api/calendars", async (context) => {
  const input = await parseBody(context.req.raw, calendarSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const ownerEmail = context.get("identity").email;
  const existing = await context.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM calendars WHERE owner_email = ?1 AND deleted_at IS NULL",
  ).bind(ownerEmail).first<{ count: number }>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO calendars (id, owner_email, name, color, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      ).bind(id, ownerEmail, input.data.name, input.data.color, existing?.count ? 0 : 1, now),
      auditStatement(context.env.DB, {
        actorEmail: ownerEmail,
        action: "calendar.created",
        targetType: "calendar",
        targetId: id,
      }, now),
    ]);
  } catch {
    return context.json({ error: "A calendar with that name already exists" }, 409);
  }
  const row = await context.env.DB.prepare(
    `SELECT id, name, color, is_default, created_at, updated_at
     FROM calendars WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL`,
  ).bind(id, ownerEmail).first<CalendarRow>();
  if (!row) return context.json({ error: "Calendar could not be created" }, 500);
  return context.json({ calendar: mapCalendar(row) }, 201);
});

api.patch("/api/calendars/:id", async (context) => {
  const input = await parseBody(context.req.raw, calendarSchema.partial().refine((value) => Object.keys(value).length > 0, "Add a calendar change"));
  if (!input.ok) return context.json({ error: input.error }, 400);
  const ownerEmail = context.get("identity").email;
  const current = await context.env.DB.prepare(
    `SELECT id, name, color, is_default, created_at, updated_at FROM calendars
     WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL`,
  ).bind(context.req.param("id"), ownerEmail).first<CalendarRow>();
  if (!current) return context.json({ error: "Calendar not found" }, 404);
  const now = new Date().toISOString();
  try {
    await context.env.DB.prepare(
      `UPDATE calendars SET name = ?1, color = ?2, updated_at = ?3
       WHERE id = ?4 AND owner_email = ?5 AND deleted_at IS NULL`,
    ).bind(input.data.name ?? current.name, input.data.color ?? current.color, now, current.id, ownerEmail).run();
  } catch {
    return context.json({ error: "A calendar with that name already exists" }, 409);
  }
  return context.json({ calendar: mapCalendar({ ...current, name: input.data.name ?? current.name, color: input.data.color ?? current.color, updated_at: now }) });
});

api.delete("/api/calendars/:id", async (context) => {
  const ownerEmail = context.get("identity").email;
  const id = context.req.param("id");
  const calendar = await context.env.DB.prepare(
    "SELECT is_default FROM calendars WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL",
  ).bind(id, ownerEmail).first<{ is_default: number }>();
  if (!calendar) return context.json({ error: "Calendar not found" }, 404);
  if (calendar.is_default) return context.json({ error: "The default calendar cannot be deleted" }, 409);
  const now = new Date().toISOString();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE calendar_events SET deleted_at = ?1, updated_at = ?1 WHERE calendar_id = ?2 AND owner_email = ?3 AND deleted_at IS NULL",
    ).bind(now, id, ownerEmail),
    context.env.DB.prepare(
      "UPDATE calendars SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND owner_email = ?3 AND deleted_at IS NULL",
    ).bind(now, id, ownerEmail),
    auditStatement(context.env.DB, {
      actorEmail: ownerEmail,
      action: "calendar.deleted",
      targetType: "calendar",
      targetId: id,
    }, now),
  ]);
  return context.json({ ok: true });
});

api.get("/api/calendar/events", async (context) => {
  const start = validDateFilter(context.req.query("start"));
  const end = validDateFilter(context.req.query("end"));
  if (!start || !end || Date.parse(end) <= Date.parse(start)) return context.json({ error: "Choose a valid calendar range" }, 400);
  if (Date.parse(end) - Date.parse(start) > 370 * 86_400_000) return context.json({ error: "Calendar ranges may not exceed 370 days" }, 400);
  const result = await context.env.DB.prepare(
    `SELECT id, calendar_id, title, start_at, end_at, all_day, timezone, location, description,
            availability, recurrence_frequency, recurrence_interval, recurrence_until, reminder_minutes,
            created_at, updated_at
     FROM calendar_events
     WHERE owner_email = ?1 AND deleted_at IS NULL AND (
       (recurrence_frequency = 'none' AND start_at < ?3 AND end_at > ?2)
       OR
       (recurrence_frequency != 'none' AND start_at < ?3 AND (recurrence_until IS NULL OR recurrence_until >= ?2))
     )
     ORDER BY start_at, title COLLATE NOCASE
     LIMIT 5000`,
  ).bind(context.get("identity").email, start, end).all<CalendarEventRow>();
  return context.json({ events: result.results.map(mapCalendarEvent) });
});

api.post("/api/calendar/events", async (context) => {
  const input = await parseBody(context.req.raw, calendarEventSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const ownerEmail = context.get("identity").email;
  if (!await calendarBelongsTo(context.env.DB, ownerEmail, input.data.calendarId)) {
    return context.json({ error: "Calendar not found" }, 404);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.DB.batch([
    calendarEventInsert(context.env.DB, id, ownerEmail, input.data, now),
    auditStatement(context.env.DB, {
      actorEmail: ownerEmail,
      action: "calendar_event.created",
      targetType: "calendar_event",
      targetId: id,
    }, now),
  ]);
  const row = await calendarEventById(context.env.DB, ownerEmail, id);
  if (!row) return context.json({ error: "Event could not be created" }, 500);
  return context.json({ event: mapCalendarEvent(row) }, 201);
});

api.put("/api/calendar/events/:id", async (context) => {
  const input = await parseBody(context.req.raw, calendarEventSchema);
  if (!input.ok) return context.json({ error: input.error }, 400);
  const ownerEmail = context.get("identity").email;
  if (!await calendarBelongsTo(context.env.DB, ownerEmail, input.data.calendarId)) {
    return context.json({ error: "Calendar not found" }, 404);
  }
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `UPDATE calendar_events SET
       calendar_id = ?1, title = ?2, start_at = ?3, end_at = ?4, all_day = ?5,
       timezone = ?6, location = ?7, description = ?8, availability = ?9,
       recurrence_frequency = ?10, recurrence_interval = ?11, recurrence_until = ?12,
       reminder_minutes = ?13, updated_at = ?14
     WHERE id = ?15 AND owner_email = ?16 AND deleted_at IS NULL`,
  ).bind(
    input.data.calendarId, input.data.title, input.data.startAt, input.data.endAt,
    input.data.allDay ? 1 : 0, input.data.timezone, input.data.location, input.data.description,
    input.data.availability, input.data.recurrenceFrequency, input.data.recurrenceInterval,
    input.data.recurrenceUntil, input.data.reminderMinutes, now, context.req.param("id"), ownerEmail,
  ).run();
  if (!result.meta.changes) return context.json({ error: "Event not found" }, 404);
  await writeAudit(context.env.DB, {
    actorEmail: ownerEmail,
    action: "calendar_event.updated",
    targetType: "calendar_event",
    targetId: context.req.param("id"),
  }, now);
  const row = await calendarEventById(context.env.DB, ownerEmail, context.req.param("id"));
  if (!row) return context.json({ error: "Event not found" }, 404);
  return context.json({ event: mapCalendarEvent(row) });
});

api.delete("/api/calendar/events/:id", async (context) => {
  const ownerEmail = context.get("identity").email;
  const id = context.req.param("id");
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    "UPDATE calendar_events SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND owner_email = ?3 AND deleted_at IS NULL",
  ).bind(now, id, ownerEmail).run();
  if (!result.meta.changes) return context.json({ error: "Event not found" }, 404);
  await writeAudit(context.env.DB, {
    actorEmail: ownerEmail,
    action: "calendar_event.deleted",
    targetType: "calendar_event",
    targetId: id,
  }, now);
  return context.json({ ok: true });
});

api.notFound((context) => context.json({ error: "Not found" }, 404));

api.onError((error, context) => {
  console.error(JSON.stringify({
    message: "API request failed",
    error: error instanceof Error ? error.message : "unknown",
    method: context.req.method,
    path: context.req.path,
  }));
  return context.json({ error: "cfmail could not complete that request" }, 500);
});

async function getMessage(db: D1Database, id: string): Promise<MessageDetailRow | null> {
  return db
    .prepare("SELECT m.*, t.message_count FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?")
    .bind(id)
    .first<MessageDetailRow>();
}

async function hydrateMessage(db: D1Database, row: MessageDetailRow): Promise<MessageDetail> {
  const [attachments, labels] = await Promise.all([
    db.prepare("SELECT id, filename, mime_type, size_bytes, is_inline FROM attachments WHERE message_id = ?")
      .bind(row.id)
      .all<AttachmentRow>(),
    db.prepare(
      `SELECT l.id, l.name, l.color FROM message_labels ml
       JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ? ORDER BY l.name COLLATE NOCASE`,
    ).bind(row.id).all<LabelRow>(),
  ]);
  return {
    ...mapMessage({ ...row, labels_json: JSON.stringify(labels.results) }),
    to: safeJson(row.to_json, []),
    cc: safeJson(row.cc_json, []),
    bcc: safeJson(row.bcc_json, []),
    replyToEmail: row.reply_to_email,
    textBody: row.text_body,
    hasHtmlBody: Boolean(row.html_body),
    hasRemoteImages: proxyableRemoteImageUrls(row.html_body).length > 0,
    internetMessageId: row.internet_message_id,
    inReplyTo: row.in_reply_to,
    attachments: attachments.results.map(mapAttachment),
  };
}

async function fetchRemoteImage(initialUrl: string, blockedHostname: string): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!safeRemoteImageUrl(url, blockedHostname)) return new Response(null, { status: 400 });
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
        "User-Agent": "cfmail-image-proxy/1.0",
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("Location");
    if (!location) return new Response(null, { status: 502 });
    url = new URL(location, url).toString();
  }
  return new Response(null, { status: 508 });
}

function limitResponseBody(body: ReadableStream<Uint8Array>, maximumBytes: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel("Remote image exceeded cfmail's size limit");
        controller.error(new Error("Remote image exceeded cfmail's size limit"));
        return;
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const result = schema.safeParse(await request.json());
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, error: result.error.issues[0]?.message || "Invalid request" };
  } catch {
    return { ok: false, error: "Expected a JSON request body" };
  }
}

function mapDomain(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    status: row.status,
    inboundEnabled: Boolean(row.inbound_enabled),
    outboundEnabled: Boolean(row.outbound_enabled),
    zoneId: row.zone_id,
    health: {
      routing: row.routing_status,
      sending: row.sending_status,
      spf: row.spf_status,
      dkim: row.dkim_status,
      dmarc: row.dmarc_status,
      checkedAt: row.health_checked_at,
    },
  };
}

function mapIdentity(row: IdentityRow): IdentityRecord {
  return {
    id: row.id,
    domainId: row.domain_id,
    email: row.email,
    displayName: row.display_name,
    isDefault: Boolean(row.is_default),
    signatureText: row.signature_text,
    signatureHtml: row.signature_html,
  };
}

function mapMessage(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    threadId: row.thread_id,
    domainId: row.domain_id,
    identityId: row.identity_id,
    direction: row.direction,
    folder: row.folder,
    deliveryStatus: row.delivery_status,
    fromName: row.from_name,
    fromEmail: row.from_email,
    subject: row.subject,
    preview: row.preview,
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    hasAttachments: Boolean(row.has_attachments),
    receivedAt: row.received_at,
    messageCount: row.message_count,
    labels: safeJson<LabelRecord[]>(row.labels_json || "[]", []),
    sendAfter: row.send_after || null,
    lastError: row.last_error || null,
  };
}

function mapAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    isInline: Boolean(row.is_inline),
  };
}

function mapDraft(row: DraftRow, attachmentIds: string[] = []): DraftRecord {
  return {
    id: row.id,
    identityId: row.identity_id,
    threadId: row.thread_id,
    replyToMessageId: row.reply_to_message_id,
    to: safeJson(row.to_json, []),
    cc: safeJson(row.cc_json, []),
    bcc: safeJson(row.bcc_json, []),
    subject: row.subject,
    textBody: row.text_body,
    attachmentIds,
    updatedAt: row.updated_at,
  };
}

function mapLabel(row: LabelRow): LabelRecord {
  return { id: row.id, name: row.name, color: row.color };
}

function mapDocumentSummary(row: DocumentSummaryRow): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    preview: row.plain_text.replace(/\s+/g, " ").trim().slice(0, 160),
    wordCount: wordCount(row.plain_text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    ...mapDocumentSummary(row),
    contentHtml: row.content_html,
    plainText: row.plain_text,
    page: safeJson<DocumentPageSettings>(row.page_json, { size: "letter", orientation: "portrait", margins: "normal" }),
  };
}

async function documentForSourceAttachment(
  db: D1Database,
  ownerEmail: string,
  sourceAttachmentId: string,
): Promise<DocumentRow | null> {
  return db.prepare(
    `SELECT id, title, content_html, plain_text, page_json, created_at, updated_at
     FROM documents
     WHERE owner_email = ?1 AND source_attachment_id = ?2 AND deleted_at IS NULL
     LIMIT 1`,
  ).bind(ownerEmail, sourceAttachmentId).first<DocumentRow>();
}

function mapWorkbookSummary(row: WorkbookSummaryRow): WorkbookSummary {
  return {
    id: row.id,
    title: row.title,
    preview: row.preview,
    sheetCount: row.sheet_count,
    cellCount: row.cell_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkbook(row: WorkbookRow): WorkbookRecord {
  return {
    ...mapWorkbookSummary(row),
    workbook: safeJson<WorkbookData>(row.workbook_json, {
      activeSheetId: "00000000-0000-4000-8000-000000000000",
      sheets: [{ id: "00000000-0000-4000-8000-000000000000", name: "Sheet1", cells: {} }],
    }),
  };
}

function mapCalendar(row: CalendarRow): CalendarRecord {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCalendarEvent(row: CalendarEventRow): CalendarEventRecord {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: Boolean(row.all_day),
    timezone: row.timezone,
    location: row.location,
    description: row.description,
    availability: row.availability,
    recurrenceFrequency: row.recurrence_frequency,
    recurrenceInterval: row.recurrence_interval,
    recurrenceUntil: row.recurrence_until,
    reminderMinutes: row.reminder_minutes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function calendarBelongsTo(db: D1Database, ownerEmail: string, id: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 AS found FROM calendars WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL",
  ).bind(id, ownerEmail).first<{ found: number }>();
  return Boolean(row?.found);
}

function calendarEventInsert(
  db: D1Database,
  id: string,
  ownerEmail: string,
  event: z.infer<typeof calendarEventSchema>,
  now: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO calendar_events (
       id, calendar_id, owner_email, title, start_at, end_at, all_day, timezone, location,
       description, availability, recurrence_frequency, recurrence_interval, recurrence_until,
       reminder_minutes, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
  ).bind(
    id, event.calendarId, ownerEmail, event.title, event.startAt, event.endAt, event.allDay ? 1 : 0,
    event.timezone, event.location, event.description, event.availability, event.recurrenceFrequency,
    event.recurrenceInterval, event.recurrenceUntil, event.reminderMinutes, now,
  );
}

function calendarEventById(db: D1Database, ownerEmail: string, id: string): Promise<CalendarEventRow | null> {
  return db.prepare(
    `SELECT id, calendar_id, title, start_at, end_at, all_day, timezone, location, description,
            availability, recurrence_frequency, recurrence_interval, recurrence_until, reminder_minutes,
            created_at, updated_at
     FROM calendar_events
     WHERE id = ?1 AND owner_email = ?2 AND deleted_at IS NULL`,
  ).bind(id, ownerEmail).first<CalendarEventRow>();
}

function workbookStats(workbook: WorkbookData): { preview: string; sheetCount: number; cellCount: number } {
  const cells = workbook.sheets.flatMap((sheet) => Object.values(sheet.cells));
  const preview = cells
    .map((cell) => cell.value)
    .filter((value) => value !== null && value !== "")
    .slice(0, 12)
    .join(" · ")
    .slice(0, 160);
  return { preview, sheetCount: workbook.sheets.length, cellCount: cells.length };
}

async function workbookForSourceAttachment(
  db: D1Database,
  ownerEmail: string,
  sourceAttachmentId: string,
): Promise<WorkbookRow | null> {
  return db.prepare(
    `SELECT id, title, workbook_json, preview, sheet_count, cell_count, created_at, updated_at
     FROM workbooks
     WHERE owner_email = ?1 AND source_attachment_id = ?2 AND deleted_at IS NULL
     LIMIT 1`,
  ).bind(ownerEmail, sourceAttachmentId).first<WorkbookRow>();
}

function wordCount(value: string): number {
  const words = value.trim().match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return words?.length || 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toFtsQuery(value: string): string {
  return value
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}@._+-]/gu, ""))
    .filter(Boolean)
    .slice(0, 20)
    .map((term) => `"${term.replace(/"/g, "\"\"")}"*`)
    .join(" AND ") || '""';
}

function validDateFilter(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

async function checkDomainHealth(domain: string): Promise<{
  routing: string;
  sending: string;
  spf: string;
  dkim: string;
  dmarc: string;
  detail: Record<string, unknown>;
}> {
  const [mx, spfRecords, dmarcRecords, dkimTxtRecords, dkimCnameRecords] = await Promise.all([
    dnsAnswers(domain, "MX"),
    dnsAnswers(domain, "TXT"),
    dnsAnswers(`_dmarc.${domain}`, "TXT"),
    dnsAnswers(`cf-bounce._domainkey.${domain}`, "TXT"),
    dnsAnswers(`cf-bounce._domainkey.${domain}`, "CNAME"),
  ]);
  const spf = spfRecords.some((record) => /v=spf1/i.test(record) && /cloudflare/i.test(record)) ? "healthy" : "missing";
  const dkimRecords = [...dkimTxtRecords, ...dkimCnameRecords];
  const dkim = dkimRecords.length ? "healthy" : "missing";
  const dmarc = dmarcRecords.some((record) => /v=dmarc1/i.test(record)) ? "healthy" : "missing";
  const routing = mx.some((record) => /\.mx\.cloudflare\.net/i.test(record)) ? "healthy" : "missing";
  return {
    routing,
    sending: spf === "healthy" && dkim === "healthy" ? "healthy" : "needs_attention",
    spf,
    dkim,
    dmarc,
    detail: { mx, spfRecords, dmarcRecords, dkimRecords },
  };
}

async function dnsAnswers(name: string, type: "MX" | "TXT" | "CNAME"): Promise<string[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  const response = await fetch(url, { headers: { Accept: "application/dns-json" } });
  if (!response.ok) return [];
  const data = await response.json<{ Answer?: { data?: string }[] }>();
  return (data.Answer || []).flatMap((answer) => typeof answer.data === "string" ? [answer.data.replace(/^"|"$/g, "")] : []);
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toMailAddresses(addresses: string[]): MailAddress[] {
  return addresses.map((address) => ({ name: "", email: address }));
}

interface DomainRow {
  id: string;
  name: string;
  label: string;
  status: "active" | "paused";
  inbound_enabled: number;
  outbound_enabled: number;
  zone_id: string | null;
  routing_status: string;
  sending_status: string;
  spf_status: string;
  dkim_status: string;
  dmarc_status: string;
  health_checked_at: string | null;
}

interface IdentityRow {
  id: string;
  domain_id: string;
  email: string;
  display_name: string;
  is_default: number;
  signature_text: string;
  signature_html: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  domain_id: string;
  identity_id: string | null;
  direction: "inbound" | "outbound";
  folder: "inbox" | "sent" | "archive" | "spam" | "trash";
  delivery_status: "scheduled" | "queued" | "delivered" | "bounced" | "failed" | "cancelled" | "unknown";
  from_name: string;
  from_email: string;
  subject: string;
  preview: string;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  received_at: string;
  message_count: number;
  labels_json?: string;
  send_after: string | null;
  last_error: string | null;
}

interface MessageDetailRow extends MessageRow {
  internet_message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_email: string | null;
  text_body: string;
  html_body: string;
}

interface AttachmentRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  is_inline: number;
}

interface AttachmentDocumentRow extends AttachmentRow {
  document_id: string | null;
}

interface AttachmentWorkbookRow extends AttachmentRow {
  workbook_id: string | null;
}

interface SendIdentityRow {
  id: string;
  domain_id: string;
  email: string;
  display_name: string;
  signature_text: string;
  signature_html: string;
  outbound_enabled: number;
  status: "active" | "paused";
}

interface ReplyTargetRow {
  id: string;
  thread_id: string;
  domain_id: string;
  internet_message_id: string | null;
  references_json: string;
  subject: string;
}

interface DraftRow {
  id: string;
  identity_id: string | null;
  thread_id: string | null;
  reply_to_message_id: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  text_body: string;
  updated_at: string;
}

interface LabelRow {
  id: string;
  name: string;
  color: string;
}

interface UploadRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  object_key: string;
}

interface ContactRow {
  email: string;
  name: string;
  interaction_count: number;
  last_contacted_at: string;
}

interface AuditRow {
  id: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string | null;
  detail_json: string;
  created_at: string;
}

interface DeliveryEventRow {
  id: string;
  message_id: string | null;
  event_type: string;
  status: string;
  detail: string | null;
  occurred_at: string;
  subject: string | null;
  from_email: string | null;
}

interface DocumentSummaryRow {
  id: string;
  title: string;
  plain_text: string;
  created_at: string;
  updated_at: string;
}

interface DocumentRow extends DocumentSummaryRow {
  content_html: string;
  page_json: string;
}

interface WorkbookSummaryRow {
  id: string;
  title: string;
  preview: string;
  sheet_count: number;
  cell_count: number;
  created_at: string;
  updated_at: string;
}

interface WorkbookRow extends WorkbookSummaryRow {
  workbook_json: string;
}

interface CalendarRow {
  id: string;
  name: string;
  color: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface CalendarEventRow {
  id: string;
  calendar_id: string;
  title: string;
  start_at: string;
  end_at: string;
  all_day: number;
  timezone: string;
  location: string;
  description: string;
  availability: CalendarEventRecord["availability"];
  recurrence_frequency: CalendarEventRecord["recurrenceFrequency"];
  recurrence_interval: number;
  recurrence_until: string | null;
  reminder_minutes: number | null;
  created_at: string;
  updated_at: string;
}
