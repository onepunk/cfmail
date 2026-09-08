import type { SpreadsheetCell, SpreadsheetCellStyle, SpreadsheetValue, WorkbookData } from "../shared/types";
import { cellAddress, evaluateCell, parseCellAddress } from "./spreadsheetModel";

interface SheetJsStyle {
  font?: { bold?: boolean; italic?: boolean; underline?: boolean; color?: { rgb?: string } };
  fill?: { fgColor?: { rgb?: string } };
  alignment?: { horizontal?: string };
}

export async function importXlsx(arrayBuffer: ArrayBuffer): Promise<{ workbook: WorkbookData; warnings: string[] }> {
  const XLSX = await import("xlsx");
  const source = XLSX.read(arrayBuffer, { type: "array", cellFormula: true, cellNF: true, cellStyles: true });
  const warnings: string[] = [];
  const sheets = source.SheetNames.slice(0, 20).map((name) => {
    const worksheet = source.Sheets[name];
    const cells: Record<string, SpreadsheetCell> = {};
    const rawRange = worksheet?.["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : null;
    const range = rawRange ? {
      s: rawRange.s,
      e: { r: Math.min(rawRange.e.r, 1_999), c: Math.min(rawRange.e.c, 99) },
    } : null;
    if (rawRange && (rawRange.e.r > 1_999 || rawRange.e.c > 99)) warnings.push(`${name} was limited to the first 2,000 rows and 100 columns.`);
    if (range) {
      for (let row = range.s.r; row <= range.e.r; row += 1) {
        for (let column = range.s.c; column <= range.e.c; column += 1) {
          const address = cellAddress(row, column);
          const sourceCell = worksheet[address] as (typeof worksheet[string] & { s?: SheetJsStyle }) | undefined;
          if (!sourceCell || typeof sourceCell !== "object") continue;
          const style = importStyle(sourceCell.s, sourceCell.z);
          const value = normalizeImportedValue(sourceCell.v);
          cells[address] = {
            value,
            ...(sourceCell.f ? { formula: `=${sourceCell.f}` } : {}),
            ...(Object.keys(style).length ? { style } : {}),
          };
        }
      }
    }
    const columnWidths: Record<string, number> = {};
    (worksheet?.["!cols"] || []).slice(0, 100).forEach((column, index) => {
      const width = Math.round(Number(column?.wpx) || Number(column?.wch) * 8 || 0);
      if (width >= 40) columnWidths[XLSX.utils.encode_col(index)] = Math.min(width, 500);
    });
    return { id: crypto.randomUUID(), name: name.slice(0, 31) || "Sheet", cells, ...(Object.keys(columnWidths).length ? { columnWidths } : {}) };
  });
  if (source.SheetNames.length > 20) warnings.push("Only the first 20 worksheets were imported.");
  if (!sheets.length) sheets.push({ id: crypto.randomUUID(), name: "Sheet1", cells: {} });
  return { workbook: { activeSheetId: sheets[0].id, sheets }, warnings };
}

export async function workbookToXlsx(workbook: WorkbookData): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const output = XLSX.utils.book_new();
  workbook.sheets.forEach((sheet) => {
    const worksheet: Record<string, unknown> = {};
    let maxRow = 0;
    let maxColumn = 0;
    Object.entries(sheet.cells).forEach(([address, cell]) => {
      const parsed = parseCellAddress(address);
      if (!parsed) return;
      maxRow = Math.max(maxRow, parsed.row);
      maxColumn = Math.max(maxColumn, parsed.column);
      const calculated = evaluateCell(sheet, address);
      const value = cell.formula && !String(calculated).startsWith("#") ? calculated : cell.value;
      worksheet[address] = {
        ...exportValue(value),
        ...(cell.formula ? { f: cell.formula.replace(/^=/, "") } : {}),
        ...(cell.style?.numberFormat ? { z: cell.style.numberFormat } : {}),
        ...(cell.style ? { s: exportStyle(cell.style) } : {}),
      };
    });
    worksheet["!ref"] = `A1:${cellAddress(maxRow, maxColumn)}`;
    if (sheet.columnWidths && Object.keys(sheet.columnWidths).length) {
      worksheet["!cols"] = Array.from({ length: maxColumn + 1 }, (_, index) => {
        const width = sheet.columnWidths?.[XLSX.utils.encode_col(index)];
        return width ? { wpx: width } : undefined;
      });
    }
    XLSX.utils.book_append_sheet(output, worksheet, safeSheetName(sheet.name));
  });
  return XLSX.write(output, { bookType: "xlsx", type: "array", compression: true, cellStyles: true }) as ArrayBuffer;
}

export async function downloadXlsx(title: string, workbook: WorkbookData): Promise<void> {
  const bytes = await workbookToXlsx(workbook);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(title)}.xlsx`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function normalizeImportedValue(value: unknown): SpreadsheetValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function importStyle(style: SheetJsStyle | undefined, numberFormat: string | undefined): SpreadsheetCellStyle {
  const textColor = normalizeRgb(style?.font?.color?.rgb);
  const fillColor = normalizeRgb(style?.fill?.fgColor?.rgb);
  const align = ["left", "center", "right"].includes(style?.alignment?.horizontal || "")
    ? style?.alignment?.horizontal as SpreadsheetCellStyle["align"]
    : undefined;
  return compact({
    bold: style?.font?.bold,
    italic: style?.font?.italic,
    underline: Boolean(style?.font?.underline) || undefined,
    textColor,
    fillColor,
    align,
    numberFormat: numberFormat && numberFormat !== "General" ? numberFormat : undefined,
  });
}

function exportValue(value: SpreadsheetValue | string): { t: "n" | "b" | "s"; v: number | boolean | string } {
  if (typeof value === "number") return { t: "n", v: value };
  if (typeof value === "boolean") return { t: "b", v: value };
  return { t: "s", v: value === null ? "" : String(value) };
}

function exportStyle(style: SpreadsheetCellStyle): SheetJsStyle {
  return {
    font: {
      ...(style.bold ? { bold: true } : {}),
      ...(style.italic ? { italic: true } : {}),
      ...(style.underline ? { underline: true } : {}),
      ...(style.textColor ? { color: { rgb: style.textColor.slice(1).toUpperCase() } } : {}),
    },
    ...(style.fillColor ? { fill: { fgColor: { rgb: style.fillColor.slice(1).toUpperCase() } } } : {}),
    ...(style.align ? { alignment: { horizontal: style.align } } : {}),
  };
}

function normalizeRgb(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const rgb = value.replace(/^FF/i, "").slice(-6);
  return /^[0-9a-f]{6}$/i.test(rgb) ? `#${rgb.toLowerCase()}` : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== false)) as T;
}

function safeFilename(value: string): string {
  return (value.trim() || "Book").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\.xlsx$/i, "").slice(0, 120);
}

function safeSheetName(value: string): string {
  return (value.trim() || "Sheet").replace(/[\\/?*\[\]:]/g, "-").slice(0, 31);
}
