# cfmail Spreadsheets

cfmail Spreadsheets is the spreadsheet workspace built into cfmail. Open it from
the nine-dot app launcher at the top left of Mail, or open an `.xlsx` attachment
directly from a message.

## Capabilities

- Sparse editable grid with sticky row and column headings
- Formula bar and safe formula calculation without dynamic code execution
- `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `IF`, `ROUND`, and `ABS`
- Cell references, ranges, arithmetic, comparisons, concatenation, and circular
  reference detection
- Bold, italic, underline, text colour, fill colour, alignment, and common
  number, percentage, and currency formats
- Multi-cell tab/newline paste, keyboard navigation, multiple worksheets,
  worksheet rename/delete, templates, zoom, and D1 autosave
- `.xlsx` import and export using SheetJS Community Edition
- Source-linked mail imports: reopening the same attachment returns to the same
  editable workbook while the original attachment remains unchanged in R2

## Compatibility

The importer preserves cell values, formulas, worksheet names, common number
formats, basic cell formatting, and column widths within the editor limits of
20 worksheets, 2,000 rows, and 100 columns per worksheet. Files larger than 15
MB are left available for original download instead of being imported.

Unsupported spreadsheet features such as macros, pivot tables, charts, data
transformation queries, data validation, comments, external links, and advanced
conditional formatting are not executed. Formulas outside the supported
calculation set retain their cached result when one is present and remain in the
exported workbook.

The original `.xlsx` mail attachment is immutable. Editing or exporting affects
only the source-linked cfmail copy.
