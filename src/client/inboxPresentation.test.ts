import { describe, expect, it } from "vitest";
import type { MessageSummary } from "../shared/types";
import { messageMatchesView, presentMessages } from "./inboxPresentation";

function message(overrides: Partial<MessageSummary> & Pick<MessageSummary, "id" | "receivedAt">): MessageSummary {
  return {
    threadId: overrides.id,
    domainId: "domain-1",
    identityId: null,
    direction: "inbound",
    folder: "inbox",
    deliveryStatus: "delivered",
    fromName: "Sender",
    fromEmail: "sender@example.com",
    subject: "Subject",
    preview: "Preview",
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    messageCount: 1,
    labels: [],
    sendAfter: null,
    lastError: null,
    ...overrides,
  };
}

describe("inbox presentation", () => {
  it("supports the inline message views", () => {
    const unread = message({ id: "unread", receivedAt: "2026-08-28T10:00:00Z", isRead: false });
    const starred = message({ id: "starred", receivedAt: "2026-08-28T09:00:00Z", isStarred: true });
    const attached = message({ id: "attached", receivedAt: "2026-08-28T08:00:00Z", hasAttachments: true });

    expect(messageMatchesView(unread, "unread")).toBe(true);
    expect(messageMatchesView(starred, "starred")).toBe(true);
    expect(messageMatchesView(attached, "attachments")).toBe(true);
    expect(messageMatchesView(starred, "unread")).toBe(false);
  });

  it("sorts newest first and groups calendar ranges", () => {
    const groups = presentMessages([
      message({ id: "month", receivedAt: "2026-08-03T10:00:00Z" }),
      message({ id: "today", receivedAt: "2026-08-28T08:00:00Z" }),
      message({ id: "yesterday", receivedAt: "2026-08-27T12:00:00Z" }),
    ], "all", "newest", new Date("2026-08-28T12:00:00Z"));

    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "This month"]);
    expect(groups.flatMap((group) => group.messages.map((item) => item.id))).toEqual(["today", "yesterday", "month"]);
  });

  it("can sort and group by sender", () => {
    const groups = presentMessages([
      message({ id: "z", receivedAt: "2026-08-28T08:00:00Z", fromName: "Zulu" }),
      message({ id: "a", receivedAt: "2026-08-28T07:00:00Z", fromName: "Alpha" }),
    ], "all", "sender", new Date("2026-08-28T12:00:00Z"));

    expect(groups.map((group) => group.label)).toEqual(["A", "Z"]);
    expect(groups.flatMap((group) => group.messages.map((item) => item.id))).toEqual(["a", "z"]);
  });
});
