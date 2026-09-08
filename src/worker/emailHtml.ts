interface PrepareEmailHtmlOptions {
  loadRemoteImages?: boolean;
  blockedHostname?: string;
}

export function prepareEmailHtml(source: string, messageId: string, nonce: string, options: PrepareEmailHtmlOptions = {}): string {
  const baseStyles = `<style data-cfmail-viewer>html,body{max-width:100%!important;min-height:0!important;overflow-x:hidden!important;background:#fff}body{margin:0!important}img,video{max-width:100%!important;height:auto}table{max-width:100%!important}a{overflow-wrap:anywhere}</style>`;
  const safeMessageId = JSON.stringify(messageId).replace(/</g, "\\u003c");
  const resizeScript = `<script nonce="${nonce}">(()=>{const send=()=>parent.postMessage({type:"cfmail:email-height",messageId:${safeMessageId},height:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)},"*");addEventListener("load",send);new ResizeObserver(send).observe(document.documentElement);setTimeout(send,50);setTimeout(send,400)})();</script>`;
  // Normalize parsed links instead of rewriting untrusted HTML with a regex.
  // Only this nonce-authorized script runs; sender scripts remain blocked.
  const linkScript = `<script nonce="${nonce}">
    (() => {
      const prepareLinks = () => {
        document.querySelectorAll("a[href],area[href]").forEach(link => {
          const href = link.getAttribute("href").trim();
          link.removeAttribute("ping");
          link.removeAttribute("download");
          if (href.startsWith("#")) {
            link.setAttribute("target", "_self");
            return;
          }
          try {
            const url = new URL(href.startsWith("//") ? "https:" + href : href);
            if (!["https:", "http:", "mailto:"].includes(url.protocol)) throw new Error("Unsupported link");
            link.setAttribute("href", url.href);
            link.setAttribute("target", "_blank");
            link.setAttribute("rel", "noopener noreferrer");
          } catch {
            link.removeAttribute("href");
          }
        });
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", prepareLinks, { once: true });
      else prepareLinks();
    })();
  </script>`;
  const body = options.loadRemoteImages ? proxyRemoteImages(source, messageId, options.blockedHostname) : source;
  let html = /<\/head\s*>/i.test(body) ? body.replace(/<\/head\s*>/i, `${baseStyles}</head>`) : `${baseStyles}${body}`;
  html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${linkScript}${resizeScript}</body>`) : `${html}${linkScript}${resizeScript}`;
  return html;
}

export function proxyableRemoteImageUrls(source: string, blockedHostname?: string): string[] {
  const urls = new Set<string>();
  source.match(/<img\b[^>]*>/gi)?.forEach((tag) => {
    const url = imageSource(tag);
    if (url && safeRemoteImageUrl(url, blockedHostname) && !likelyTrackingImage(tag, url)) urls.add(url);
  });
  return [...urls];
}

export function safeRemoteImageUrl(value: string, blockedHostname?: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const normalizedBlockedHostname = blockedHostname?.toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname === normalizedBlockedHostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
    if (hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function proxyRemoteImages(source: string, messageId: string, blockedHostname?: string): string {
  const allowed = new Set(proxyableRemoteImageUrls(source, blockedHostname));
  return source.replace(/<img\b[^>]*>/gi, (tag) => {
    const url = imageSource(tag);
    if (!url || !allowed.has(url)) return tag;
    const proxy = `/api/messages/${encodeURIComponent(messageId)}/remote-image?url=${encodeURIComponent(url)}`;
    return tag
      .replace(/\s+srcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
      .replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="${proxy.replace(/&/g, "&amp;")}"`);
  });
}

function imageSource(tag: string): string | null {
  const match = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!value) return null;
  return value.replace(/&amp;/gi, "&").replace(/&#0*38;/gi, "&").replace(/&#x0*26;/gi, "&").replace(/&quot;/gi, '"').trim();
}

function likelyTrackingImage(tag: string, url: string): boolean {
  const hiddenAttribute = /\b(?:width|height)\s*=\s*["']?(?:0|1)(?:px)?["']?(?=\s|>|\/)/i.test(tag);
  const styleMatch = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const style = styleMatch?.[1] ?? styleMatch?.[2] ?? styleMatch?.[3] ?? "";
  const hiddenStyle = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|(?:width|height)\s*:\s*(?:0|1)(?:px)?)\s*(?:!important)?\s*(?=;|$)/i.test(style);
  const trackingPath = /(?:\/opens?\/|pixel|beacon|blank\.gif|track(?:ing)?[\/_-])/i.test(url);
  return hiddenAttribute || hiddenStyle || trackingPath;
}
