import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderPdf } from "@/features/pdf/render";
import type { ReportView } from "@/features/reports/definitions";
import { exportedSections, reportMadeAt, reportPdfDocument, reportPdfFileName } from "@/features/reports/pdf";

import { formatMoney } from "@/lib/format";

import { pdfText } from "./pdf-text";

// RPT-02 (owner, 1 November 2026, answer (4) א): a report's PDF, made on our server from the same shaped view as its CSV and
// Excel files, read back from a real file: Hebrew in visual order, amounts with ₪, percentages, a table longer than a page
// with its header on every page, and COL-06's link-only section left out.

const reverse = (s: string) => [...s].reverse().join("");

function view(rows: number): ReportView {
  return {
    kpis: [
      { label: "סך ההכנסות", value: formatMoney(123456789), hint: "לפני מע\"מ" },
      { label: "אחוז המרה", value: "42.5%" },
    ],
    sections: [
      {
        title: "לפי נציג",
        columns: [
          { key: "name", label: "נציג", kind: "text" },
          { key: "deals", label: "עסקאות", kind: "number" },
          { key: "amount", label: "סכום", kind: "money" },
          { key: "rate", label: "אחוז", kind: "percent" },
          { key: "days", label: "זמן", kind: "days" },
        ],
        rows: Array.from({ length: rows }, (_, i) => ({ name: `נציגה מספר ${i + 1} (Team A)`, deals: i + 1, amount: 123450 * (i + 1), rate: 12.5, days: null })),
        empty: "אין נתונים.",
        note: "הסכומים לפני מע\"מ.",
      },
      { title: "קישורים", columns: [{ key: "x", label: "קישור", kind: "text" }], rows: [{ x: "לדוח גיל החוב" }], empty: "", exported: false },
      { title: "ריק", columns: [{ key: "x", label: "שם", kind: "text" }], rows: [], empty: "אין שורות בחלק הזה." },
    ],
    note: "הדוח לפי מה שאתם רואים.",
  };
}

describe("the report PDF (RPT-02)", () => {
  it("is a real PDF of the shaped view: KPIs, every exported section with its header on every page, and no link-only section", async () => {
    const doc = reportPdfDocument({
      title: "הכנסות לפי נציג",
      business: "חברת הדוגמה",
      periodText: "תקופה: 1 באוק׳ 2026 עד 31 באוק׳ 2026",
      filters: ["נציג: דנה כהן"],
      madeAt: reportMadeAt(new Date("2026-11-01T12:05:00Z"), "Asia/Jerusalem"),
      view: view(90),
    });
    const bytes = await renderPdf(doc);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    if (process.env.RPT02_PDF_OUT) writeFileSync(process.env.RPT02_PDF_OUT, bytes);

    const pages = pdfText(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const pieces = pages.flatMap((page) => page.pieces.map((p) => p.text));
    const all = pieces.join("\n");

    expect(pieces).toContain(reverse("הכנסות לפי נציג"));
    expect(pieces).toContain(reverse("חברת הדוגמה"));
    expect(pieces).toContain(reverse("נציג: דנה כהן"));
    // "הופק ב-01.11.2026 14:05" in visual order: the time ends up at the left end
    expect(pieces).toContain(`14:05 01.11.2026-${reverse("הופק ב")}`);
    // KPIs, amounts and percentages left to right
    // formatMoney puts a no-break space between the sign and the amount
    expect(pieces).toContain("₪\u00a01,234,567.89");
    expect(pieces).toContain("42.5%");
    expect(pieces).toContain("₪\u00a01,234.50");
    expect(pieces).toContain("12.5%");
    // Hebrew with English and a number in one cell
    expect(pieces).toContain(`(Team A) 7 ${reverse("נציגה מספר")}`);
    // the table's header on every page the rows are on
    const tablePages = pages.filter((page) => page.pieces.some((p) => p.text.includes("(Team A)")));
    expect(tablePages.length).toBeGreaterThanOrEqual(2);
    for (const page of tablePages) expect(page.pieces.map((p) => p.text)).toContain(reverse("עסקאות"));
    // an empty value is a dash, an empty section says so, the notes are there
    expect(pieces).toContain("—");
    expect(all).toContain(reverse("אין שורות בחלק הזה."));
    expect(all).toContain(reverse("הדוח לפי מה שאתם רואים"));
    // COL-06: a section of links only stays on the screen
    expect(all).not.toContain(reverse("לדוח גיל החוב"));
    expect(all).not.toContain(reverse("קישורים"));
    pages.forEach((page, i) => expect(page.pieces.map((p) => p.text)).toContain(`${pages.length} ךותמ ${i + 1} דומע`));
    expect(all).not.toContain("�");
  });

  it("a report with no KPIs and no rows still makes a one-page file", async () => {
    const empty: ReportView = { kpis: [], sections: [{ title: "ריק", columns: [{ key: "x", label: "שם", kind: "text" }], rows: [], empty: "אין נתונים." }] };
    const pages = pdfText(await renderPdf(reportPdfDocument({ title: "דוח", business: "עסק", periodText: "מצב נוכחי", filters: [], madeAt: "הופק", view: empty })));
    expect(pages).toHaveLength(1);
    expect(pages[0].pieces.map((p) => p.text)).toContain(reverse("אין נתונים."));
  });

  it("keeps COL-06's link-only sections out, names the file like the CSV and dates it in the business's zone", () => {
    expect(exportedSections(view(1)).map((s) => s.title)).toEqual(["לפי נציג", "ריק"]);
    expect(reportPdfFileName("revenue", "2026-10-01")).toBe("report-revenue-2026-10-01.pdf");
    // 22:30 UTC on 31 October is already 1 November in Israel
    expect(reportMadeAt(new Date("2026-10-31T22:30:00Z"), "Asia/Jerusalem")).toBe("הופק ב-01.11.2026 00:30");
    expect(reportMadeAt(new Date("2026-10-31T22:30:00Z"), "UTC")).toBe("הופק ב-31.10.2026 22:30");
  });
});
