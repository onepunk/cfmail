import type {
  AttachmentRecord,
  AuditRecord,
  ContactRecord,
  CalendarEventInput,
  CalendarEventRecord,
  CalendarRecord,
  DocumentPageSettings,
  DocumentRecord,
  DocumentSummary,
  DomainRecord,
  DraftRecord,
  IdentityRecord,
  IdentityRouting,
  LabelRecord,
  MailFilters,
  MailboxBootstrap,
  MailboxSettings,
  MessageDetail,
  MessageSummary,
  UploadRecord,
  WorkbookData,
  WorkbookRecord,
  WorkbookSummary,
} from "../shared/types";

export class ApiError extends Error {
  status: number;
  code?: string;
  loginUrl?: string;

  constructor(message: string, status: number, code?: string, loginUrl?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.loginUrl = loginUrl;
  }
}

interface RequestOptions extends RequestInit {
  json?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; code?: string; loginUrl?: string } & T;
  if (!response.ok) throw new ApiError(payload.error || "Request failed", response.status, payload.code, payload.loginUrl);
  return payload;
}

async function requestFile(path: string, filename: string, fallbackMimeType: string): Promise<File> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; code?: string; loginUrl?: string };
    throw new ApiError(payload.error || "File request failed", response.status, payload.code, payload.loginUrl);
  }
  const blob = await response.blob();
  return new File([blob], filename, { type: blob.type || fallbackMimeType });
}

export const mailApi = {
  session: () => request<{ authenticated: boolean; user: { email: string } }>("/api/session"),
  logout: () => request<{ logoutUrl: string }>("/api/auth/logout", { method: "POST", json: {} }),
  bootstrap: () => request<MailboxBootstrap>("/api/bootstrap"),
  messages: (folder: string, domainId: string | null, query: string, cursor: string | null = null, limit = 50, filters: MailFilters = {}) => {
    const search = new URLSearchParams({ folder, limit: String(limit) });
    if (domainId) search.set("domainId", domainId);
    if (query) search.set("q", query);
    if (cursor) search.set("cursor", cursor);
    if (filters.sender) search.set("sender", filters.sender);
    if (filters.recipient) search.set("recipient", filters.recipient);
    if (filters.dateFrom) search.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) search.set("dateTo", filters.dateTo);
    if (filters.attachment) search.set("attachment", "true");
    if (filters.unread) search.set("unread", "true");
    if (filters.starred) search.set("starred", "true");
    if (filters.labelId) search.set("labelId", filters.labelId);
    return request<{ messages: MessageSummary[]; hasMore: boolean; nextCursor: string | null }>(`/api/messages?${search}`, { cache: "no-store" });
  },
  message: (id: string) => request<{ message: MessageDetail; thread: MessageDetail[] }>(`/api/messages/${id}`),
  updateMessage: (id: string, action: "read" | "unread" | "star" | "unstar" | "archive" | "spam" | "not_spam" | "trash" | "restore" | "cancel") =>
    request<{ ok: boolean }>(`/api/messages/${id}`, { method: "PATCH", json: { action } }),
  bulkMessages: (ids: string[], action: "read" | "unread" | "star" | "unstar" | "archive" | "spam" | "not_spam" | "trash" | "restore") =>
    request<{ ok: boolean; changed: number }>("/api/messages/bulk", { method: "POST", json: { ids, action } }),
  deleteMessage: (id: string) => request<{ ok: boolean }>(`/api/messages/${id}`, { method: "DELETE" }),
  setLabels: (id: string, labelIds: string[]) => request<{ ok: boolean }>(`/api/messages/${id}/labels`, { method: "PUT", json: { labelIds } }),
  send: (data: {
    identityId: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    textBody: string;
    replyToMessageId?: string | null;
    confirmCrossDomain?: boolean;
    attachmentIds?: string[];
    clientRequestId?: string;
  }) => request<{ id: string; threadId: string; status: string; sendAfter: string }>("/api/messages/send", { method: "POST", json: data }),
  upload: async (files: File[]) => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    return request<{ uploads: UploadRecord[] }>("/api/uploads", { method: "POST", body });
  },
  documentForAttachment: (id: string) => request<{ attachment: AttachmentRecord; documentId: string | null }>(`/api/attachments/${id}/document`),
  spreadsheetForAttachment: (id: string) => request<{ attachment: AttachmentRecord; workbookId: string | null }>(`/api/attachments/${id}/spreadsheet`),
  attachmentFile: (attachment: AttachmentRecord, filename = attachment.filename) =>
    requestFile(`/api/attachments/${attachment.id}`, filename, attachment.mimeType),
  drafts: () => request<{ drafts: DraftRecord[] }>("/api/drafts"),
  saveDraft: (draft: Omit<DraftRecord, "updatedAt">) =>
    request<{ id: string; updatedAt: string }>("/api/drafts", { method: "PUT", json: draft }),
  deleteDraft: (id: string) => request<{ ok: boolean }>(`/api/drafts/${id}`, { method: "DELETE", json: {} }),
  documents: () => request<{ documents: DocumentSummary[] }>("/api/documents"),
  document: (id: string) => request<{ document: DocumentRecord }>(`/api/documents/${id}`),
  createDocument: (data: { title?: string; contentHtml?: string; plainText?: string; page?: DocumentPageSettings; sourceAttachmentId?: string | null } = {}) =>
    request<{ document: DocumentRecord; reused?: boolean }>("/api/documents", { method: "POST", json: data }),
  saveDocument: (id: string, data: { title: string; contentHtml: string; plainText: string; page: DocumentPageSettings }) =>
    request<{ updatedAt: string }>(`/api/documents/${id}`, { method: "PUT", json: data }),
  deleteDocument: (id: string) => request<{ ok: boolean }>(`/api/documents/${id}`, { method: "DELETE", json: {} }),
  workbooks: () => request<{ workbooks: WorkbookSummary[] }>("/api/workbooks"),
  workbook: (id: string) => request<{ workbook: WorkbookRecord }>(`/api/workbooks/${id}`),
  createWorkbook: (data: { title?: string; workbook: WorkbookData; sourceAttachmentId?: string | null }) =>
    request<{ workbook: WorkbookRecord; reused?: boolean }>("/api/workbooks", { method: "POST", json: data }),
  saveWorkbook: (id: string, data: { title: string; workbook: WorkbookData }) =>
    request<{ updatedAt: string }>(`/api/workbooks/${id}`, { method: "PUT", json: data }),
  deleteWorkbook: (id: string) => request<{ ok: boolean }>(`/api/workbooks/${id}`, { method: "DELETE", json: {} }),
  calendars: () => request<{ calendars: CalendarRecord[] }>("/api/calendars", { cache: "no-store" }),
  createCalendar: (data: { name: string; color: string }) =>
    request<{ calendar: CalendarRecord }>("/api/calendars", { method: "POST", json: data }),
  updateCalendar: (id: string, data: { name?: string; color?: string }) =>
    request<{ calendar: CalendarRecord }>(`/api/calendars/${id}`, { method: "PATCH", json: data }),
  deleteCalendar: (id: string) => request<{ ok: boolean }>(`/api/calendars/${id}`, { method: "DELETE", json: {} }),
  calendarEvents: (start: string, end: string) => {
    const search = new URLSearchParams({ start, end });
    return request<{ events: CalendarEventRecord[] }>(`/api/calendar/events?${search}`, { cache: "no-store" });
  },
  createCalendarEvent: (data: CalendarEventInput) =>
    request<{ event: CalendarEventRecord }>("/api/calendar/events", { method: "POST", json: data }),
  updateCalendarEvent: (id: string, data: CalendarEventInput) =>
    request<{ event: CalendarEventRecord }>(`/api/calendar/events/${id}`, { method: "PUT", json: data }),
  deleteCalendarEvent: (id: string) => request<{ ok: boolean }>(`/api/calendar/events/${id}`, { method: "DELETE", json: {} }),
  addDomain: (data: { name: string; label: string; inboundEnabled: boolean; outboundEnabled: boolean }) =>
    request<{ id: string }>("/api/domains", { method: "POST", json: data }),
  addIdentity: (data: { domainId: string; email: string; displayName: string; isDefault: boolean; signatureText: string; signatureHtml: string }) =>
    request<{ id: string; routing: IdentityRouting }>("/api/identities", { method: "POST", json: data }),
  updateIdentity: (id: string, data: { displayName: string; isDefault: boolean; signatureText: string; signatureHtml: string }) =>
    request<{ ok: boolean }>(`/api/identities/${id}`, { method: "PATCH", json: data }),
  domainHealth: (id: string) => request<{ health: DomainRecord["health"] }>(`/api/domains/${id}/health`, { method: "POST", json: {} }),
  domainStorage: (id: string) => request<{ messages: number; rawBytes: number; attachmentBytes: number }>(`/api/domains/${id}/storage`),
  contacts: (query = "") => request<{ contacts: ContactRecord[] }>(`/api/contacts?q=${encodeURIComponent(query)}`),
  addLabel: (name: string, color: string) => request<{ id: string }>("/api/labels", { method: "POST", json: { name, color } }),
  audit: () => request<{ entries: AuditRecord[] }>("/api/audit"),
  delivery: () => request<{ summary: Array<{ domainId: string; status: string; count: number }>; recent: Array<{ id: string; messageId: string; subject: string; fromEmail: string; eventType: string; status: string; detail: string | null; occurredAt: string }> }>("/api/delivery/summary"),
  updateSettings: (settings: MailboxSettings) => request<{ ok: boolean }>("/api/settings", { method: "PATCH", json: settings }),
};

export type { DomainRecord, IdentityRecord, LabelRecord };
