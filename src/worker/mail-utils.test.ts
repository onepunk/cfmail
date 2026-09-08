import { describe, expect, it } from "vitest";
import {
  appendHtmlSignature,
  appendTextSignature,
  domainFromAddress,
  decodeMessageCursor,
  encodeMessageCursor,
  makePreview,
  normalizeSubject,
  parseReferences,
  plainTextToHtml,
  replySubject,
  safeFilename,
  textFromMessage,
} from "./mail-utils";

describe("mail utilities", () => {
  it("normalizes reply prefixes and whitespace", () => {
    expect(normalizeSubject(" Re: FWD:  Quarterly   update ")).toBe("quarterly update");
  });

  it("extracts a recipient domain safely", () => {
    expect(domainFromAddress("Hello@EXAMPLE.COM")).toBe("example.com");
    expect(domainFromAddress("invalid")).toBeNull();
  });

  it("limits references to the most recent twenty", () => {
    const references = Array.from({ length: 25 }, (_, index) => `<${index}@test>`).join(" ");
    expect(parseReferences(references)).toHaveLength(20);
    expect(parseReferences(references)[0]).toBe("<5@test>");
  });

  it("uses safe plain text when only HTML is available", () => {
    expect(textFromMessage(undefined, "<p>Hello <strong>there</strong></p><script>bad()</script>")).toBe(
      "Hello there",
    );
  });

  it("makes compact previews and safe filenames", () => {
    expect(makePreview(" hello\n\nworld ")).toBe("hello world");
    expect(safeFilename("../../report.pdf", 0)).toBe(".._.._report.pdf");
  });

  it("adds a reply prefix only once", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
  });

  it("creates a safe HTML alternative from plain text", () => {
    expect(plainTextToHtml("Hello <team> & friends\nLine two\n\nGoodbye")).toBe(
      "<p>Hello &lt;team&gt; &amp; friends<br>Line two</p>\n<p>Goodbye</p>",
    );
    expect(plainTextToHtml("<script>alert('bad')</script>")).not.toContain("<script>");
    expect(plainTextToHtml("**Important** and _careful_\n\n- One\n- Two")).toBe(
      "<p><strong>Important</strong> and <em>careful</em></p>\n<ul><li>One</li><li>Two</li></ul>",
    );
  });

  it("adds matching text and HTML signatures", () => {
    expect(appendTextSignature("Hello\n", "Alex\nExample Co")).toBe("Hello\n\n-- \nAlex\nExample Co");
    expect(appendTextSignature("Hello", "  ")).toBe("Hello");
    expect(appendHtmlSignature("<p>Hello</p>\n", "<strong>Alex</strong>")).toBe(
      '<p>Hello</p>\n<div data-cfmail-signature="true" style="margin-top:24px"><strong>Alex</strong></div>',
    );
  });

  it("round trips stable message pagination cursors", () => {
    const cursor = { receivedAt: "2026-08-26T12:00:00.000Z", id: "00000000-0000-4000-8000-000000000001" };
    expect(decodeMessageCursor(encodeMessageCursor(cursor))).toEqual(cursor);
    expect(decodeMessageCursor("not-a-cursor")).toBeNull();
  });
});
