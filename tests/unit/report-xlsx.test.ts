import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { ReportView } from "@/features/reports/definitions";
import { reportXlsxCell, reportXlsxRows } from "@/features/reports/xlsx";
import { excelDate, sheetName, xlsxFile, xlsxSheet } from "@/lib/xlsx";

const parts = (file: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(file)).map(([path, bytes]) => [path, strFromU8(bytes)]));

describe("report cells in Excel (RPT-02)", () => {
  it("writes money as shekels, percent as a fraction and counts as numbers", () => {
    expect(reportXlsxCell("money", 125050)).toEqual({ type: "money", value: 1250.5 });
    expect(reportXlsxCell("percent", 42.5)).toEqual({ type: "percent", value: 0.425 });
    expect(reportXlsxCell("number", 7)).toEqual({ type: "number", value: 7 });
    expect(reportXlsxCell("days", 3.5)).toEqual({ type: "number", value: 3.5 });
    expect(reportXlsxCell("minutes", 90)).toEqual({ type: "number", value: 90 });
  });

  it("keeps text and strings as text, and empty as empty", () => {
    expect(reportXlsxCell("text", "שם")).toBe("שם");
    expect(reportXlsxCell("money", "לא ידוע")).toBe("לא ידוע");
    expect(reportXlsxCell("number", null)).toBeNull();
    expect(reportXlsxCell("number", undefined)).toBeNull();
  });

  it("lays out the same lines as the CSV", () => {
    const view: ReportView = {
      kpis: [],
      sections: [
        {
          title: "לפי מקור",
          columns: [
            { key: "name", label: "מקור", kind: "text" },
            { key: "revenue", label: "הכנסה", kind: "money" },
            { key: "rate", label: "המרה", kind: "percent" },
          ],
          rows: [{ name: "אתר", revenue: 990000, rate: 12.5 }],
          empty: "",
        },
      ],
    };
    const rows = reportXlsxRows("לידים לפי מקור", { fromDate: "2026-10-01", toDate: "2026-10-31" }, view);
    expect(rows).toEqual([
      [{ type: "text", value: "לידים לפי מקור", bold: true }],
      ["תקופה", { type: "date", value: "2026-10-01" }, { type: "date", value: "2026-10-31" }],
      [],
      [{ type: "text", value: "לפי מקור", bold: true }],
      [
        { type: "text", value: "מקור", bold: true },
        { type: "text", value: "הכנסה (₪)", bold: true },
        { type: "text", value: "המרה", bold: true },
      ],
      ["אתר", { type: "money", value: 9900 }, { type: "percent", value: 0.125 }],
    ]);
    expect(reportXlsxRows("מצב", null, { kpis: [], sections: [] })).toHaveLength(1);
  });
});

describe("xlsx cells", () => {
  it("turns calendar days into Excel serial days", () => {
    expect(excelDate("1900-03-01")).toBe(61);
    expect(excelDate("2026-10-14")).toBe(46309);
    expect(excelDate("2026-02-30")).toBeNull();
    expect(excelDate("14/10/2026")).toBeNull();
    expect(excelDate("2026-10-14T00:00:00Z")).toBeNull();
  });

  it("writes typed cells with their styles, right to left", () => {
    const xml = parts(
      xlsxSheet("דוח", [
        [{ type: "text", value: "כותרת", bold: true }],
        [
          { type: "money", value: 1250.5 },
          { type: "percent", value: 0.425 },
          { type: "number", value: 7 },
          { type: "number", value: 3.5 },
          { type: "date", value: "2026-10-14" },
          { type: "date", value: "לא תאריך" },
          null,
          "a<b",
        ],
      ]),
    );
    const sheet = xml["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).not.toContain("<pane");
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">כותרת</t></is></c>');
    expect(sheet).toContain('<c r="A2" s="2"><v>1250.5</v></c>');
    expect(sheet).toContain('<c r="B2" s="3"><v>0.425</v></c>');
    expect(sheet).toContain('<c r="C2" s="5"><v>7</v></c>');
    expect(sheet).toContain('<c r="D2" s="6"><v>3.5</v></c>');
    expect(sheet).toContain('<c r="E2" s="4"><v>46309</v></c>');
    expect(sheet).toContain('<c r="F2" t="inlineStr"><is><t xml:space="preserve">לא תאריך</t></is></c>');
    expect(sheet).not.toContain('r="G2"');
    expect(sheet).toContain("a&lt;b");
    const styles = xml["xl/styles.xml"];
    expect(styles).toContain('<cellXfs count="7">');
    expect((styles.match(/<xf numFmtId=/g) ?? []).length).toBe(8);
    expect(styles).toContain("₪");
    expect(xml["xl/workbook.xml"]).toContain('<sheet name="דוח"');
  });

  it("keeps the list export as before: a bold frozen header row of text", () => {
    const sheet = parts(xlsxFile("לידים", ["שם"], [["דנה"]]))["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is>');
  });
});

describe("sheet names", () => {
  it("drops forbidden characters and keeps at most 31", () => {
    expect(sheetName("לידים: לפי/מקור [2026]?*")).toBe("לידים לפי מקור 2026");
    expect(sheetName("א".repeat(40))).toHaveLength(31);
    expect(sheetName("'ציטוט'")).toBe("ציטוט");
    expect(sheetName("  ")).toBe("Sheet1");
    expect(sheetName("History", "דוח")).toBe("דוח");
    expect(sheetName(":/?", "דוח")).toBe("דוח");
  });

  it("every report title makes a valid sheet name", async () => {
    const { REPORTS } = await import("@/features/reports/definitions");
    for (const report of REPORTS) {
      const name = sheetName(report.title, "דוח");
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(31);
      expect(name).not.toMatch(/[:\\/?*[\]]/);
    }
  });
});
