import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/orders/actions", () => ({ storeOrderPdfAction: vi.fn() }));

import { OrderPdfButton } from "@/features/orders/components/order-pdf-button";
import { PDF_FROM_PERSONAL, pdfQuotaZero } from "@/features/plans/pdf-quota";

// Owner (337) א, 12 November 2026: a PDF quota of exactly zero (the free plan) shows "זמין מחבילת אישית" on the report and
// order PDF buttons instead of a quota error; the server still refuses.
describe("PDF buttons while the plan's PDF quota is zero (owner (337) א)", () => {
  it("only a quota of exactly zero counts, never no cap or a used-up quota", () => {
    expect(pdfQuotaZero(0)).toBe(true);
    expect(pdfQuotaZero("0")).toBe(true);
    expect(pdfQuotaZero(null)).toBe(false);
    expect(pdfQuotaZero(undefined)).toBe(false);
    expect(pdfQuotaZero(1000)).toBe(false);
    expect(PDF_FROM_PERSONAL).toBe("זמין מחבילת אישית");
  });

  it("the order PDF button is disabled with the line, and a kept PDF still downloads", () => {
    const base = { orgId: "o", orderId: "d", canStore: true };
    const keep = renderToStaticMarkup(createElement(OrderPdfButton, { ...base, href: null, pdfZero: true }));
    expect(keep).toContain(PDF_FROM_PERSONAL);
    expect(keep).toContain("disabled");
    const normal = renderToStaticMarkup(createElement(OrderPdfButton, { ...base, href: null }));
    expect(normal).not.toContain(PDF_FROM_PERSONAL);
    const kept = renderToStaticMarkup(createElement(OrderPdfButton, { ...base, href: "/f", outdated: true, pdfZero: true }));
    expect(kept).toContain("הורדת PDF");
    expect(kept).toContain(PDF_FROM_PERSONAL);
  });

  it("the report page and the order actions read the zero quota", () => {
    const page = readFileSync(join(process.cwd(), "src/app/o/[orgId]/reports/[report]/page.tsx"), "utf8");
    expect(page).toContain("orgPdfQuotaZero(orgId)");
    expect(page).toContain("{PDF_FROM_PERSONAL}");
    const actions = readFileSync(join(process.cwd(), "src/features/orders/actions.ts"), "utf8");
    expect(actions.match(/orgPdfQuotaZero\(orgId\)/g)?.length).toBe(5);
  });
});
