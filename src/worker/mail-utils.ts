import type { Address, Mailbox } from "postal-mime";
import type { MailAddress } from "../shared/types";

const REPLY_PREFIX = /^(?:(?:re|fw|fwd)\s*:\s*)+/i;
const WHITESPACE = /\s+/g;
const HTML_TAG = /<[^>]*>/g;

export function normalizeSubject(subject: string | undefined): string {
  const value = (subject || "(no subject)")
    .trim()
    .replace(REPLY_PREFIX, "")
    .replace(WHITESPACE, " ")
    .trim()
    .toLocaleLowerCase();
  return value || "(no subject)";
}

export function normalizeMessageId(value: string | undefined | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(value.matchAll(/<[^>]+>/g), (match) => match[0]).slice(-20);
}

export function domainFromAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLocaleLowerCase();
}

export function flattenAddresses(addresses: Address[] | undefined): MailAddress[] {
  if (!addresses) return [];
  const result: MailAddress[] = [];
  for (const address of addresses) {
    if ("group" in address && address.group) {
      for (const member of address.group) result.push(toMailAddress(member));
    } else {
      result.push(toMailAddress(address));
    }
  }
  return result.filter((address) => address.email.length > 0);
}

export function firstAddress(address: Address | undefined): MailAddress {
  if (!address) return { name: "", email: "unknown@invalid" };
  if ("group" in address && address.group) {
    const member = address.group[0];
    return member ? toMailAddress(member) : { name: "", email: "unknown@invalid" };
  }
  return toMailAddress(address);
}

function toMailAddress(mailbox: Mailbox): MailAddress {
  return {
    name: mailbox.name?.trim() || "",
    email: mailbox.address?.trim().toLocaleLowerCase() || "",
  };
}

export function textFromMessage(text: string | undefined, html: string | undefined): string {
  if (text?.trim()) return text.trim();
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(HTML_TAG, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function makePreview(text: string): string {
  return text.replace(WHITESPACE, " ").trim().slice(0, 240);
}

export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split("\n");
      if (lines.length && lines.every((line) => /^[-*] /.test(line))) {
        return `<ul>${lines.map((line) => `<li>${formatInline(line.slice(2))}</li>`).join("")}</ul>`;
      }
      return `<p>${formatInline(paragraph).replace(/\n/g, "<br>") || "<br>"}</p>`;
    })
    .join("\n");
}

export function appendTextSignature(body: string, signature: string): string {
  const trimmedSignature = signature.trim();
  return trimmedSignature ? `${body.trimEnd()}\n\n-- \n${trimmedSignature}` : body;
}

export function appendHtmlSignature(bodyHtml: string, signatureHtml: string): string {
  const trimmedSignature = signatureHtml.trim();
  return trimmedSignature
    ? `${bodyHtml.trimEnd()}\n<div data-cfmail-signature="true" style="margin-top:24px">${trimmedSignature}</div>`
    : bodyHtml;
}

function formatInline(value: string): string {
  return value
    .replace(/\[([^\]\n]+)\]\(((?:https:\/\/|mailto:)[^\s)]+)\)/gi, '<a href="$2" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>");
}

export interface MessageCursor {
  receivedAt: string;
  id: string;
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeMessageCursor(value: string): MessageCursor | null {
  if (!value || value.length > 512) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as unknown;
    if (!decoded || typeof decoded !== "object") return null;
    const candidate = decoded as Partial<MessageCursor>;
    if (
      typeof candidate.receivedAt !== "string" ||
      Number.isNaN(Date.parse(candidate.receivedAt)) ||
      typeof candidate.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id)
    ) {
      return null;
    }
    return { receivedAt: candidate.receivedAt, id: candidate.id };
  } catch {
    return null;
  }
}

export function safeFilename(filename: string | null, index: number): string {
  const value = filename || `attachment-${index + 1}`;
  return value.replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 180);
}

export function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}
