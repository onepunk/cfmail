# cfmail Documents

cfmail Documents is the document editor inside cfmail. It stores editable
documents in D1 and can import and export `.docx` files.

## Capabilities

- Launch from the Documents button in the cfmail header and return to Mail
  without a separate sign-in.
- Create blank documents or find meeting-notes, letter, project, résumé,
  report, invoice, and journal templates by category or search.
- Store each document in D1 under the authenticated Cloudflare Access identity.
- Autosave edits, titles, and page settings; show live save state, word count,
  character count, and recently opened order.
- Import `.docx` into safe editor HTML and download a new `.docx` copy.
- Open `.docx` mail attachments directly in Documents. The first open creates a
  source-linked editable copy, later opens reuse it, and the original R2 mail
  attachment remains unchanged.
- Format fonts, size, bold, italic, underline, strikethrough, subscript,
  superscript, colour, highlighting, headings, quotes, lists, indentation, and
  paragraph alignment.
- Insert links, pictures, 3×3 tables, rules, symbols, and date/time.
- Change Letter/A4 size, portrait/landscape orientation, and page margins.
- Work in a productivity-style application shell with command search, grouped
  Home, Insert, Layout, References, Review, View, and Help ribbons, document
  actions, a page-navigation rail, dark/light backgrounds, and a document status
  bar.
- Filter and sort recent documents, navigate live page previews and headings,
  and jump to the current page from the status bar.
- Edit in separate block-paginated page surfaces with page count and print page
  breaks, while storing a clean document body without editor-only wrappers.
- Find and replace, browser spellchecking, print, focus mode, zoom, common
  keyboard shortcuts, formatting marks, checklist markers, line spacing,
  paragraph shading, case changes, and a fit-to-width mobile editing surface.

## Compatibility boundary

Import is a safe content conversion rather than a lossless OOXML round trip. It
preserves text, headings, lists, links, tables, pictures, and common inline
formatting. Export creates a new `.docx` with the supported content and selected
page settings.

Macros, embedded objects, diagrams, charts, equations, fields, section
breaks, tracked changes, comments, headers and footers, footnotes, and citations
are not preserved. Pagination keeps whole imported blocks together and does not
reproduce a desktop publishing layout engine exactly. Do not overwrite the only
copy of a complex source document after editing it in cfmail Documents.
