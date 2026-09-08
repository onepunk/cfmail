export type Folder = "inbox" | "sent" | "archive" | "spam" | "trash";

export interface MailAddress {
  name: string;
  email: string;
}

export interface DomainRecord {
  id: string;
  name: string;
  label: string;
  status: "active" | "paused";
  inboundEnabled: boolean;
  outboundEnabled: boolean;
  zoneId: string | null;
  health: DomainHealth;
}

export interface DomainHealth {
  routing: string;
  sending: string;
  spf: string;
  dkim: string;
  dmarc: string;
  checkedAt: string | null;
}

export interface IdentityRecord {
  id: string;
  domainId: string;
  email: string;
  displayName: string;
  isDefault: boolean;
  signatureText: string;
  signatureHtml: string;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  domainId: string;
  identityId: string | null;
  direction: "inbound" | "outbound";
  folder: Folder;
  deliveryStatus: "scheduled" | "queued" | "delivered" | "bounced" | "failed" | "cancelled" | "unknown";
  fromName: string;
  fromEmail: string;
  subject: string;
  preview: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  receivedAt: string;
  messageCount: number;
  labels: LabelRecord[];
  sendAfter: string | null;
  lastError: string | null;
}

export interface AttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
}

export interface MessageDetail extends MessageSummary {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyToEmail: string | null;
  textBody: string;
  hasHtmlBody: boolean;
  hasRemoteImages: boolean;
  internetMessageId: string | null;
  inReplyTo: string | null;
  attachments: AttachmentRecord[];
}

export interface MailboxBootstrap {
  domains: DomainRecord[];
  identities: IdentityRecord[];
  unreadCount: number;
  counts: MailboxCount[];
  labels: LabelRecord[];
  settings: MailboxSettings;
  user: { email: string };
}

export interface MailboxCount {
  domainId: string;
  folder: Folder;
  total: number;
  unread: number;
}

export interface LabelRecord {
  id: string;
  name: string;
  color: string;
}

export interface MailboxSettings {
  undoSendSeconds: number;
  trashRetentionDays: number;
  backupRetentionDays: number;
}

export interface UploadRecord {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ContactRecord {
  email: string;
  name: string;
  interactionCount: number;
  lastContactedAt: string;
}

export interface AuditRecord {
  id: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface MailFilters {
  sender?: string;
  recipient?: string;
  dateFrom?: string;
  dateTo?: string;
  attachment?: boolean;
  unread?: boolean;
  starred?: boolean;
  labelId?: string;
}

export interface DraftRecord {
  id: string;
  identityId: string | null;
  threadId: string | null;
  replyToMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  attachmentIds: string[];
  updatedAt: string;
}

export type DocumentPageSize = "letter" | "a4";
export type DocumentOrientation = "portrait" | "landscape";
export type DocumentMargins = "normal" | "narrow" | "wide";

export interface DocumentPageSettings {
  size: DocumentPageSize;
  orientation: DocumentOrientation;
  margins: DocumentMargins;
}

export interface DocumentSummary {
  id: string;
  title: string;
  preview: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRecord extends DocumentSummary {
  contentHtml: string;
  plainText: string;
  page: DocumentPageSettings;
}

export type SpreadsheetValue = string | number | boolean | null;
export type SpreadsheetAlignment = "left" | "center" | "right";

export interface SpreadsheetCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  textColor?: string;
  fillColor?: string;
  align?: SpreadsheetAlignment;
  numberFormat?: string;
}

export interface SpreadsheetCell {
  value: SpreadsheetValue;
  formula?: string;
  style?: SpreadsheetCellStyle;
}

export interface SpreadsheetSheet {
  id: string;
  name: string;
  cells: Record<string, SpreadsheetCell>;
  columnWidths?: Record<string, number>;
}

export interface WorkbookData {
  activeSheetId: string;
  sheets: SpreadsheetSheet[];
}

export interface WorkbookSummary {
  id: string;
  title: string;
  preview: string;
  sheetCount: number;
  cellCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbookRecord extends WorkbookSummary {
  workbook: WorkbookData;
}

export type CalendarAvailability = "free" | "busy" | "tentative" | "out_of_office";
export type CalendarRecurrenceFrequency = "none" | "daily" | "weekly" | "monthly" | "yearly";

export interface CalendarRecord {
  id: string;
  name: string;
  color: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEventRecord {
  id: string;
  calendarId: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  location: string;
  description: string;
  availability: CalendarAvailability;
  recurrenceFrequency: CalendarRecurrenceFrequency;
  recurrenceInterval: number;
  recurrenceUntil: string | null;
  reminderMinutes: number | null;
  createdAt: string;
  updatedAt: string;
}

export type CalendarEventInput = Omit<CalendarEventRecord, "id" | "createdAt" | "updatedAt">;
