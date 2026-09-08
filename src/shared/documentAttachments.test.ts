import { describe, expect, it } from "vitest";
import { DOCX_MIME, documentImportFilename, isDocumentAttachment } from "./documentAttachments";

describe("document mail attachments", () => {
  it("recognizes docx files by extension or MIME type", () => {
    expect(isDocumentAttachment({ filename: "Contract.DOCX", mimeType: "application/octet-stream" })).toBe(true);
    expect(isDocumentAttachment({ filename: "contract", mimeType: DOCX_MIME })).toBe(true);
    expect(isDocumentAttachment({ filename: "contract.doc", mimeType: "application/msword" })).toBe(false);
    expect(isDocumentAttachment({ filename: "contract.pdf", mimeType: "application/pdf" })).toBe(false);
  });

  it("gives MIME-detected files an importable docx name", () => {
    expect(documentImportFilename("Contract.DOCX")).toBe("Contract.DOCX");
    expect(documentImportFilename("Contract")).toBe("Contract.docx");
    expect(documentImportFilename("  ")).toBe("Attached document.docx");
  });
});
