/// <reference types="dom-chromium-ai" />
import { detectAll } from "tinyld";

export function detectMessageLanguage(subject: string, body: string): string | null {
  const clean = (value: string) => value.replace(/https?:\/\/\S+|\S+@\S+/g, " ").replace(/^>.*$/gm, "").trim();
  const text = clean(body).slice(0, 8_000) || clean(subject);
  if ((text.match(/\p{L}/gu) || []).length < 4) return null;
  const [best, next] = detectAll(text);
  if (!best || best.accuracy < 0.2 || (next && best.accuracy - next.accuracy < 0.05)) return null;
  return best.lang;
}

export function languageName(code: string): string {
  return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
}

export function splitTranslationText(text: string, limit = 3_000): string[] {
  if (limit < 1) throw new Error("Chunk size must be positive");
  const points = Array.from(text);
  const chunks: string[] = [];
  for (let start = 0; start < points.length;) {
    let end = Math.min(start + limit, points.length);
    if (end < points.length) {
      for (let index = end - 1; index > start + limit / 2; index--) {
        if (/\s/u.test(points[index])) { end = index + 1; break; }
      }
    }
    chunks.push(points.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

export async function translateMessage(
  subject: string, body: string, sourceLanguage: string, signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<{ subject: string; body: string }> {
  if (typeof Translator === "undefined") throw new Error("Translation needs a supported desktop Chrome browser.");
  if (subject.length + body.length > 100_000) throw new Error("This message is too long to translate here (100,000 characters maximum).");
  // Call create directly from the click: a model download needs user activation.
  onProgress("Preparing translation… Chrome may download a language pack.");
  const translator = await Translator.create({
    sourceLanguage, targetLanguage: "en", signal,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        onProgress(`Downloading language pack… ${Math.round(event.loaded * 100)}%`);
      });
    },
  });
  try {
    onProgress("Translating to English…");
    const translatedSubject = subject.trim() ? await translator.translate(subject, { signal }) : subject;
    const chunks = splitTranslationText(body);
    const translated: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      signal.throwIfAborted();
      onProgress(`Translating to English… ${index + 1} of ${chunks.length}`);
      translated.push(chunk.trim() ? await translator.translate(chunk, { signal }) : chunk);
    }
    return { subject: translatedSubject, body: translated.join("\n") };
  } finally {
    translator.destroy();
  }
}
