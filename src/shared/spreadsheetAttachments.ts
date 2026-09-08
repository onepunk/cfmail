import type { AttachmentRecord } from "./types";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const MAX_SPREADSHEET_IMPORT_BYTES = 15 * 1024 * 1024;

export function isSpreadsheetAttachment(attachment: Pick<AttachmentRecord, "filename" | "mimeType">): boolean {
  return /\.xlsx$/i.test(attachment.filename.trim()) || attachment.mimeType.toLowerCase() === XLSX_MIME;
}

export function spreadsheetImportFilename(filename: string): string {
  const trimmed = filename.trim() || "Attached workbook";
  return /\.xlsx$/i.test(trimmed) ? trimmed : `${trimmed}.xlsx`;
}
