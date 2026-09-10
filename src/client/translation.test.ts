import { afterEach, describe, expect, it, vi } from "vitest";
import { detectMessageLanguage, splitTranslationText, translateMessage } from "./translation";

afterEach(() => vi.unstubAllGlobals());
describe("message language detection", () => {
  it.each([
    ["お世話になっております。広報活動の成果について無料オンラインセミナーを開催します。ぜひご参加ください。", "ja"],
    ["Hello William, thanks for your message. We look forward to meeting you tomorrow to discuss the project.", "en"],
    ["Bonjour, nous vous invitons à participer à notre réunion demain matin. Merci de confirmer votre présence.", "fr"],
    ["Hola, le invitamos a nuestra reunión mañana por la mañana. Por favor confirme su asistencia. Muchas gracias.", "es"],
    ["Guten Morgen, vielen Dank für Ihre Nachricht. Wir freuen uns auf unsere gemeinsame Besprechung morgen.", "de"],
  ])("detects %s", (body, expected) => expect(detectMessageLanguage("", body)).toBe(expected));
  it("ignores links, addresses and quoted replies", () => {
    expect(detectMessageLanguage("", "https://example.com\nhello@example.com\n> Bonjour tout le monde\n123")).toBeNull();
  });
  it("uses the subject for an empty body", () => expect(detectMessageLanguage("無料オンラインセミナーを開催します。ぜひご参加ください。", "")).toBe("ja"));
});

describe("translation", () => {
  it("chunks without dropping text or splitting emoji", () => {
    const input = "こんにちは 🌎\n".repeat(1000);
    const chunks = splitTranslationText(input, 100);
    expect(chunks.join("")).toBe(input);
    expect(chunks.every(chunk => Array.from(chunk).length <= 100 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
  it("translates subject and every body chunk and destroys the model", async () => {
    const translate = vi.fn(async (text: string) => `English: ${text}`);
    const destroy = vi.fn();
    const create = vi.fn(async () => ({ translate, destroy }));
    vi.stubGlobal("Translator", { create });
    const signal = new AbortController().signal;
    const result = await translateMessage("件名", "日本語".repeat(1500), "ja", signal, vi.fn());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceLanguage: "ja", targetLanguage: "en", signal }));
    expect(translate).toHaveBeenCalledTimes(3);
    expect(result.subject).toBe("English: 件名");
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("cleans up after translation failure", async () => {
    const destroy = vi.fn();
    vi.stubGlobal("Translator", { create: async () => ({ translate: async () => { throw new Error("failed"); }, destroy }) });
    await expect(translateMessage("件名", "本文", "ja", new AbortController().signal, vi.fn())).rejects.toThrow("failed");
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("explains unsupported browsers", async () => {
    vi.stubGlobal("Translator", undefined);
    await expect(translateMessage("", "本文", "ja", new AbortController().signal, vi.fn())).rejects.toThrow("desktop Chrome");
  });
  it("rejects oversized messages before downloading", async () => {
    const create = vi.fn();
    vi.stubGlobal("Translator", { create });
    await expect(translateMessage("", "a".repeat(100001), "ja", new AbortController().signal, vi.fn())).rejects.toThrow("too long");
    expect(create).not.toHaveBeenCalled();
  });
});
