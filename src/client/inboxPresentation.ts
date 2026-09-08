import type { MessageSummary } from "../shared/types";

export type InboxView = "all" | "unread" | "starred" | "attachments";
export type InboxSort = "newest" | "oldest" | "sender";

export interface MessageGroup {
  key: string;
  label: string;
  messages: MessageSummary[];
}

export function messageMatchesView(message: MessageSummary, view: InboxView) {
  if (view === "unread") return !message.isRead;
  if (view === "starred") return message.isStarred;
  if (view === "attachments") return message.hasAttachments;
  return true;
}

export function presentMessages(
  messages: MessageSummary[],
  view: InboxView,
  sort: InboxSort,
  now = new Date(),
): MessageGroup[] {
  const visible = messages.filter((message) => messageMatchesView(message, view));
  visible.sort((left, right) => {
    if (sort === "sender") {
      const leftSender = left.fromName || left.fromEmail;
      const rightSender = right.fromName || right.fromEmail;
      return leftSender.localeCompare(rightSender, undefined, { sensitivity: "base" })
        || right.receivedAt.localeCompare(left.receivedAt);
    }
    const difference = Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
    return sort === "oldest" ? -difference : difference;
  });

  const groups = new Map<string, MessageGroup>();
  for (const message of visible) {
    const group = sort === "sender"
      ? senderGroup(message.fromName || message.fromEmail)
      : dateGroup(message.receivedAt, now);
    const current = groups.get(group.key);
    if (current) current.messages.push(message);
    else groups.set(group.key, { ...group, messages: [message] });
  }
  return Array.from(groups.values());
}

function senderGroup(sender: string) {
  const initial = sender.trim().charAt(0).toLocaleUpperCase();
  const label = /[A-Z0-9]/i.test(initial) ? initial : "#";
  return { key: `sender-${label}`, label };
}

function dateGroup(value: string, now: Date) {
  const date = startOfDay(new Date(value));
  const today = startOfDay(now);
  const dayDifference = Math.round((today.getTime() - date.getTime()) / 86_400_000);

  if (dayDifference <= 0) return { key: "today", label: "Today" };
  if (dayDifference === 1) return { key: "yesterday", label: "Yesterday" };
  if (date >= startOfWeek(today)) return { key: "this-week", label: "This week" };
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth()) {
    return { key: "this-month", label: "This month" };
  }
  return { key: "earlier", label: "Earlier" };
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function startOfWeek(value: Date) {
  const result = startOfDay(value);
  const daysSinceMonday = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - daysSinceMonday);
  return result;
}
