import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { prepareEmailHtml, proxyableRemoteImageUrls } from "./emailHtml";

describe("formatted email viewer", () => {
  function prepareLink(href: string, target = "_top") {
    const attributes = new Map(Object.entries({ href, target, ping: "https://tracker.example", download: "file" }));
    const link = {
      getAttribute: (name: string) => attributes.get(name),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
    const html = prepareEmailHtml("<p>Message</p>", "id", "nonce");
    const script = [...html.matchAll(/<script nonce="nonce">([\s\S]*?)<\/script>/g)][0][1];
    runInNewContext(script, {
      URL,
      document: { readyState: "complete", querySelectorAll: () => [link] },
    });
    return attributes;
  }

  it.each(["_blank", "_self", "_top", "newsletter", ""])("opens unsubscribe links separately regardless of sender target %s", (target) => {
    const href = "https://news.example/unsubscribe?token=abc&list=weekly";
    const attributes = prepareLink(href, target);
    expect(attributes.get("href")).toBe(href);
    expect(attributes.get("target")).toBe("_blank");
    expect(attributes.get("rel")).toBe("noopener noreferrer");
    expect(attributes.has("ping")).toBe(false);
    expect(attributes.has("download")).toBe(false);
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "/api/messages", "not a URL"])("disables unsafe or unresolved links: %s", (href) => {
    expect(prepareLink(href).has("href")).toBe(false);
  });

  it("supports mailto, HTTP, protocol-relative links, and local anchors", () => {
    expect(prepareLink("mailto:leave@example.com?subject=Unsubscribe").get("href")).toBe("mailto:leave@example.com?subject=Unsubscribe");
    expect(prepareLink("http://news.example/unsubscribe").get("target")).toBe("_blank");
    expect(prepareLink("//news.example/unsubscribe").get("href")).toBe("https://news.example/unsubscribe");
    expect(prepareLink("#footer").get("target")).toBe("_self");
  });

  it("injects responsive constraints and a nonce-scoped resize signal", () => {
    const html = prepareEmailHtml("<!doctype html><html><head><title>Test</title></head><body><table><tr><td>Hello</td></tr></table></body></html>", "message-id", "test-nonce");

    expect(html).toContain("<style data-cfmail-viewer>");
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain('type:"cfmail:email-height"');
    expect(html.indexOf("data-cfmail-viewer")).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf('nonce="test-nonce"')).toBeLessThan(html.indexOf("</body>"));
  });

  it("escapes message identifiers before embedding them in the viewer script", () => {
    const html = prepareEmailHtml("<p>Hello</p>", "</script><script>alert(1)</script>", "nonce");
    expect(html).not.toContain('messageId:"</script>');
    expect(html).toContain("\\u003c/script>");
  });

  it("proxies presentation images but leaves tracking pixels blocked", async () => {
    const source = '<html><body><img src="https://cdn.example.com/header.png"><img width="1" height="1" src="https://track.example.com/open.gif"></body></html>';
    const html = prepareEmailHtml(source, "message-id", "nonce", { loadRemoteImages: true });

    expect(proxyableRemoteImageUrls(source)).toEqual(["https://cdn.example.com/header.png"]);
    expect(html).toContain('/api/messages/message-id/remote-image?url=https%3A%2F%2Fcdn.example.com%2Fheader.png');
    expect(html).toContain('src="https://track.example.com/open.gif"');
  });

  it("does not mistake common email image widths for one-pixel trackers", () => {
    const source = [
      '<img src="https://cdn.example.com/header.png" style="display:block; width:100%; height:auto;">',
      '<img src="https://cdn.example.com/logo.png" style="display:inline-block; width:153px; height:auto; opacity:0.5;">',
      '<img src="https://cdn.example.com/tracker.png" style="width:1px; height:1px;">',
    ].join("");

    expect(proxyableRemoteImageUrls(source)).toEqual([
      "https://cdn.example.com/header.png",
      "https://cdn.example.com/logo.png",
    ]);
  });

  it("does not mistake a zero-width border for a zero-width image", () => {
    const source = [
      '<img alt="" border="0" width="684" height="232" ',
      'src="https://go.pardot.com/banner.png" ',
      'style="width: 684px; height: 232px; border-width: 0px; border-style: solid;">',
      '<img src="https://resources.example.com/open/1">',
    ].join("");

    expect(proxyableRemoteImageUrls(source)).toEqual(["https://go.pardot.com/banner.png"]);
  });

  it("rejects local, insecure, and IP-address image targets", async () => {
    const { safeRemoteImageUrl } = await import("./emailHtml");
    expect(safeRemoteImageUrl("https://cdn.example.com/image.png")).toBe(true);
    expect(safeRemoteImageUrl("http://cdn.example.com/image.png")).toBe(false);
    expect(safeRemoteImageUrl("https://localhost/image.png")).toBe(false);
    expect(safeRemoteImageUrl("https://127.0.0.1/image.png")).toBe(false);
    expect(safeRemoteImageUrl("https://mail.example.com/image.png", "mail.example.com")).toBe(false);
  });
});
