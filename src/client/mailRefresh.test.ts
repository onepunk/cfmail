import { describe, expect, it } from "vitest";
import type { MessageSummary } from "../shared/types";
import { mergeRefreshedMessages, newMessageCount } from "./mailRefresh";

function message(id: string): MessageSummary { return { id } as MessageSummary; }

describe("live mailbox refresh", () => {
  it("replaces the current first page with fresh server state", () => {
    expect(mergeRefreshedMessages([message("old")], [message("new")], 50).map((item) => item.id)).toEqual(["new"]);
  });

  it("preserves already-loaded older pages without duplicating refreshed messages", () => {
    const current = [message("first"), ...Array.from({ length: 50 }, (_, index) => message(`old-${index}`))];
    const fresh = [message("new"), message("first")];
    const merged = mergeRefreshedMessages(current, fresh, 50);
    expect(merged.slice(0, 3).map((item) => item.id)).toEqual(["new", "first", "old-0"]);
    expect(merged.filter((item) => item.id === "first")).toHaveLength(1);
  });

  it("counts only messages not already visible", () => {
    expect(newMessageCount([message("one")], [message("two"), message("one")])).toBe(1);
  });
});
