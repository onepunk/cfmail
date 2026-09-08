import { describe, expect, it } from "vitest";
import type { SpreadsheetSheet } from "../shared/types";
import { cellAddress, cellFromInput, columnName, evaluateCell, formatCellValue, parseCellAddress } from "./spreadsheetModel";

describe("spreadsheet model", () => {
  it("maps row and column coordinates to spreadsheet addresses", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(cellAddress(9, 27)).toBe("AB10");
    expect(parseCellAddress("$AB$10")).toEqual({ row: 9, column: 27 });
  });

  it("parses typed values without evaluating code", () => {
    expect(cellFromInput("42")?.value).toBe(42);
    expect(cellFromInput("TRUE")?.value).toBe(true);
    expect(cellFromInput("=1+1")?.formula).toBe("=1+1");
    expect(cellFromInput("hello")?.value).toBe("hello");
  });

  it("calculates arithmetic, ranges, functions, and cell references", () => {
    const sheet: SpreadsheetSheet = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Sheet1",
      cells: {
        A1: { value: 10 },
        A2: { value: 20 },
        B1: { value: null, formula: "=SUM(A1:A2)" },
        B2: { value: null, formula: "=AVERAGE(A1:A2)+5" },
        C1: { value: null, formula: "=IF(B1>25,\"yes\",\"no\")" },
      },
    };
    expect(evaluateCell(sheet, "B1")).toBe(30);
    expect(evaluateCell(sheet, "B2")).toBe(20);
    expect(evaluateCell(sheet, "C1")).toBe("yes");
  });

  it("reports cycles and formats common spreadsheet number formats", () => {
    const sheet: SpreadsheetSheet = { id: "00000000-0000-4000-8000-000000000001", name: "Sheet1", cells: { A1: { value: null, formula: "=B1" }, B1: { value: null, formula: "=A1" } } };
    expect(evaluateCell(sheet, "A1")).toBe("#CYCLE!");
    expect(formatCellValue(0.25, "0.00%")).toBe(new Intl.NumberFormat(undefined, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0.25));
  });
});
