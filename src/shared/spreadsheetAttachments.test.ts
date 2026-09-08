import { describe, expect, it } from "vitest";
import { XLSX_MIME, isSpreadsheetAttachment, spreadsheetImportFilename } from "./spreadsheetAttachments";

describe("spreadsheet mail attachments", () => {
  it("recognizes xlsx files by extension or MIME type", () => {
    expect(isSpreadsheetAttachment({ filename: "Budget.XLSX", mimeType: "application/octet-stream" })).toBe(true);
    expect(isSpreadsheetAttachment({ filename: "Budget", mimeType: XLSX_MIME })).toBe(true);
    expect(isSpreadsheetAttachment({ filename: "Budget.xls", mimeType: "application/vnd.ms-excel" })).toBe(false);
    expect(isSpreadsheetAttachment({ filename: "Budget.csv", mimeType: "text/csv" })).toBe(false);
  });

  it("normalizes MIME-detected filenames for import", () => {
    expect(spreadsheetImportFilename("Budget.XLSX")).toBe("Budget.XLSX");
    expect(spreadsheetImportFilename("Budget")).toBe("Budget.xlsx");
  });
});
