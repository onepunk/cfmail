import { describe, expect, it } from "vitest";
import type { WorkbookData } from "../shared/types";
import { importXlsx, workbookToXlsx } from "./xlsx";

describe("xlsx compatibility", () => {
  it("round-trips values, formulas, sheet names, and number formats", async () => {
    const workbook: WorkbookData = {
      activeSheetId: "00000000-0000-4000-8000-000000000001",
      sheets: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: "Forecast",
        cells: {
          A1: { value: "Revenue" },
          A2: { value: 1000, style: { numberFormat: "$#,##0.00" } },
          A3: { value: 500 },
          A4: { value: null, formula: "=SUM(A2:A3)" },
        },
      }],
    };

    const bytes = await workbookToXlsx(workbook);
    const imported = await importXlsx(bytes);
    const sheet = imported.workbook.sheets[0];
    expect(sheet.name).toBe("Forecast");
    expect(sheet.cells.A1.value).toBe("Revenue");
    expect(sheet.cells.A2.value).toBe(1000);
    expect(sheet.cells.A2.style?.numberFormat).toBe("$#,##0.00");
    expect(sheet.cells.A4.formula).toBe("=SUM(A2:A3)");
  });
});
