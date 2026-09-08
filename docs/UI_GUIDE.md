# cfmail UI guide

cfmail is a dense, professional mail client inspired by Outlook on the web. It should feel like a productivity application, not a SaaS dashboard.

## Design principles

1. **Mail first.** Keep navigation, lists, readers, and settings compact so content remains the focus.
2. **Flat hierarchy.** Use whitespace, dividers, and typography before adding containers. Avoid cards inside cards.
3. **Progressive disclosure.** Collapse secondary settings and long domain or identity collections by default.
4. **Quiet chrome.** Reserve blue for primary actions, selection, links, and focus. Supporting UI stays neutral.
5. **Consistent density.** Controls are generally 36px high; list rows are 48–64px depending on information density.
6. **Identity before action.** Compose, reply, and forward views show the exact sending address before mail can be sent.
7. **Safe message display.** Treat message HTML as untrusted and preserve the sandbox, sanitization, and remote-image controls.

## Theme tokens

The canonical tokens live in `src/client/styles.css` under `:root`.

- Surfaces: `--ui-surface`, `--ui-surface-subtle`, `--ui-surface-hover`, `--ui-surface-selected`
- Structure: `--ui-divider`, `--ui-radius`, `--ui-control-height`
- Spacing: `--ui-space-1` through `--ui-space-5` on a 4px base grid
- Actions and states: existing `--action`, `--success`, `--warning`, and `--danger` families

New components should use these tokens. Add a semantic token when a reusable role is missing instead of introducing a one-off colour, radius, or spacing value.

## Layout and surfaces

- Settings use one page title, one category rail, and one content column.
- Use a single divider between peer rows or sections. Do not outline every item.
- Use `--ui-surface-subtle` for expanded editors and temporary add forms.
- Shadows are reserved for overlays, menus, dialogs, and floating composers.
- Default corner radius is `--ui-radius`. Pills are only for compact statuses or counts.

## Forms

- Keep related fields in balanced two-column grids on desktop and one column on mobile.
- Labels are short and sit above text inputs. Checkbox labels sit beside the checkbox.
- Do not put a checkbox in a separate card unless it represents a complex, high-impact choice.
- Hide advanced or infrequent fields behind a clear button or disclosure control.
- Put the primary action first, followed by a quiet cancel action.

## Lists and accordions

- Use flat rows separated by `--ui-divider`.
- Domain-level groups are collapsed by default and show a name, domain, count, and chevron.
- Expanded content is indented or placed on a subtle surface rather than wrapped in another card.
- Row summaries should answer “what is this?” before exposing edit controls.

## Typography and icons

- Page title: 20–22px, semibold.
- Section title: 18–20px, semibold.
- Row title: 12–13px, semibold.
- Supporting text: 10–12px using `--muted`.
- Use Lucide icons at 16–18px. Icons support labels; they do not replace unfamiliar actions.

## Interaction and accessibility

- Every interactive element must have a visible focus state and an accessible name.
- Native `details`/`summary` is preferred for simple disclosures.
- Hover, selected, expanded, disabled, success, and error states must be visually distinct.
- Do not rely on colour alone to communicate status.
- Keep mailbox keyboard controls working: `j`/`k` or Arrow Down/Up move between messages, Enter opens a message, `c` opens compose, `/` focuses search, and `?` opens shortcut help.
- At widths below 760px, grids become single-column and nonessential metadata may be hidden.

## Review checklist

- Does the screen still work at 320px wide?
- Are secondary sections collapsed or otherwise de-emphasised?
- Can any border or container be replaced by spacing or one divider?
- Are control height, radius, spacing, and colours using theme tokens?
- Is the primary action obvious without competing blue elements?
- Do keyboard focus, labels, empty states, and errors remain clear?
