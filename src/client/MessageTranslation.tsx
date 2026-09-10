import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Languages } from "lucide-react";
import { detectMessageLanguage, languageName, translateMessage } from "./translation";

export function MessageTranslation({ subject, body, children }: { subject: string; body: string; children: ReactNode }) {
  const language = useMemo(() => detectMessageLanguage(subject, body), [subject, body]);
  const [result, setResult] = useState<{ subject: string; body: string } | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function translate() {
    if (!language || request.current) return;
    if (result) { setShowTranslation(true); return; }
    const controller = new AbortController();
    request.current = controller;
    setError("");
    try {
      const translated = await translateMessage(subject, body, language, controller.signal, setProgress);
      if (!controller.signal.aborted) { setResult(translated); setShowTranslation(true); }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error && cause.name === "Error" ? cause.message : "Translation couldn’t finish. This language may be unavailable, or its download failed. Try again in desktop Chrome.");
      }
    } finally {
      if (!controller.signal.aborted) setProgress("");
      request.current = null;
    }
  }

  return <>
    {language && language !== "en" ? <div className="translation-bar">
      <Languages size={18} aria-hidden="true" />
      <span><strong>{showTranslation ? "Translated to English" : `${languageName(language)} detected`}</strong><small>Translate on your device with Chrome. The original email is kept.</small></span>
      {showTranslation ? <button className="button quiet" onClick={() => setShowTranslation(false)}>Show original</button> : <button className="button quiet" disabled={Boolean(progress)} onClick={() => void translate()}>Translate to English</button>}
      {progress ? <p role="status">{progress}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
    {showTranslation && result ? <section className="translated-message" lang="en" aria-label="English translation"><h2>{result.subject}</h2><pre className="message-body">{result.body || "This message did not contain a readable text body."}</pre></section> : children}
  </>;
}
