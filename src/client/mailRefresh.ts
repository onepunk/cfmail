import type { MessageSummary } from "../shared/types";

export function mergeRefreshedMessages(current: MessageSummary[], fresh: MessageSummary[], pageSize: number): MessageSummary[] {
  if (current.length <= pageSize) return fresh;
  const freshIds = new Set(fresh.map((message) => message.id));
  return [...fresh, ...current.filter((message) => !freshIds.has(message.id))];
}

export function newMessageCount(current: MessageSummary[], fresh: MessageSummary[]): number {
  const currentIds = new Set(current.map((message) => message.id));
  return fresh.filter((message) => !currentIds.has(message.id)).length;
}
