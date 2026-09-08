import type { AttachmentRecord } from "./types";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_DOCUMENT_IMPORT_BYTES = 15 * 1024 * 1024;

export function isDocumentAttachment(attachment: Pick<AttachmentRecord, "filename" | "mimeType">): boolean {
  return /\.docx$/i.test(attachment.filename.trim()) || attachment.mimeType.toLowerCase() === DOCX_MIME;
}

export function documentImportFilename(filename: string): string {
  const trimmed = filename.trim() || "Attached document";
  return /\.docx$/i.test(trimmed) ? trimmed : `${trimmed}.docx`;
}
