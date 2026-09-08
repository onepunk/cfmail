import { describe, expect, it } from "vitest";
import { parseDocumentStyle, serializeDocumentStyle } from "./documentStyle";

describe("document style hydration", () => {
  it("keeps the document formatting declarations used by imported documents", () => {
    expect(parseDocumentStyle("text-align:center;margin:0px 0 4px;line-height:1.1")).toEqual([
      ["text-align", "center"],
      ["margin", "0px 0 4px"],
      ["line-height", "1.1"],
    ]);
    expect(parseDocumentStyle("font-weight:700;font-family:Calibri,Arial,sans-serif;font-size:18pt;background-color:#FFFF00")).toHaveLength(4);
  });

  it("drops executable, unknown, and priority-changing CSS", () => {
    expect(serializeDocumentStyle("background-image:url(https://example.com/pixel);position:fixed;color:red!important;color:#123456")).toBe("color:#123456");
  });

  it("preserves document indents and pagination hints", () => {
    expect(serializeDocumentStyle("margin-left:48px;text-indent:-24px;break-after:avoid-page;break-before:page")).toBe(
      "margin-left:48px;text-indent:-24px;break-after:avoid-page;break-before:page",
    );
  });
});
