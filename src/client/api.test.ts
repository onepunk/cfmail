import { afterEach, describe, expect, it, vi } from "vitest";
import { mailApi } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mail API", () => {
  it("requests a stable cursor page of messages", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ messages: [], hasMore: false, nextCursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await mailApi.messages("inbox", "domain-id", "quarterly update", "next-page", 75);

    const requestPath = String(fetchMock.mock.calls[0]?.[0]);
    const url = new URL(requestPath, "https://mail.example.com");
    expect(url.pathname).toBe("/api/messages");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      folder: "inbox",
      limit: "75",
      domainId: "domain-id",
      q: "quarterly update",
      cursor: "next-page",
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("loads an authenticated attachment as a browser File for document import", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("docx bytes", {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const file = await mailApi.attachmentFile({
      id: "5b87922d-f856-42ba-91f3-73bdd7588ac9",
      filename: "Agreement.docx",
      mimeType: "application/octet-stream",
      sizeBytes: 10,
      isInline: false,
    });

    expect(file.name).toBe("Agreement.docx");
    expect(file.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await file.text()).toBe("docx bytes");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/attachments/5b87922d-f856-42ba-91f3-73bdd7588ac9",
      { credentials: "same-origin" },
    );
  });

  it("creates a spreadsheet workbook and preserves its mail attachment link", async () => {
    const workbook = { activeSheetId: "de305d54-75b4-431b-adb2-eb6b9e546014", sheets: [{ id: "de305d54-75b4-431b-adb2-eb6b9e546014", name: "Sheet1", cells: { A1: { value: 42 } } }] };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ workbook: { id: "workbook-id", title: "Forecast", workbook } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await mailApi.createWorkbook({ title: "Forecast", workbook, sourceAttachmentId: "attachment-id" });

    expect(fetchMock).toHaveBeenCalledWith("/api/workbooks", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ title: "Forecast", workbook, sourceAttachmentId: "attachment-id" }),
    }));
  });

  it("loads calendar events using an explicit ISO range", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ events: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await mailApi.calendarEvents("2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z");

    const requestPath = String(fetchMock.mock.calls[0]?.[0]);
    const url = new URL(requestPath, "https://mail.example.com");
    expect(url.pathname).toBe("/api/calendar/events");
    expect(url.searchParams.get("start")).toBe("2026-08-24T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-08-31T00:00:00.000Z");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });
});
