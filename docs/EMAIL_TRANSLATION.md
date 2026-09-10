# Email translation

The message reader detects the language of each email locally and offers
**Translate to English** for confidently detected non-English messages, including
existing mail. Translation uses the desktop Chrome Translator API. No Google
Cloud API key, server endpoint, database migration, or additional service is needed.

The first click may download a language pack. The translated subject and plain-text
body appear in the reader; **Show original** restores the original formatted or
plain-text message. Translations stay in component memory and never replace stored
mail. Replies, forwarding, attachments and original downloads use the original data.
HTML-only emails use the plain-text representation created during mail ingestion.
Neither detection nor translation sends email content to an external translation
service. The email iframe's sandbox and remote image controls are unchanged.

Detection uses TinyLD and examines up to 8,000 characters, excluding URLs,
addresses and lines quoted with `>`. Short, ambiguous and mixed-language messages
can be misclassified or have no translation button. Supported translation languages
are determined by Chrome. Other browsers, unsupported language packs and failed
downloads show an inline error. Messages above 100,000 characters are rejected
without truncating them; smaller bodies are translated in Unicode-safe chunks.
Machine translation can be imperfect.

References:
- https://developer.chrome.com/docs/ai/translator-api
- https://github.com/komodojp/tinyld

Validation: TypeScript check, production build, Vitest suite, and an actual Japanese
sample translated in desktop Chrome. Browser checks covered English-message button
suppression, switching back to the original, and reopening the cached translation.
For deployment, use a local `wrangler.jsonc` configured with the production
resources and domain; this file is intentionally excluded from version control.
