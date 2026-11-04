import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findReport, reportRoleAllows } from "@/features/reports/definitions";
import { BINNED_CONTACT, EXPIRED_ROW, PUNCH_PARTIAL_NOTE, punchCardsView } from "@/features/reports/punch-cards";
import { isPunchDays, PUNCH_DAYS_CHOICES, PUNCH_DAYS_DEFAULT, punchDaysFromColumns } from "@/features/reports/punch-days";
import { parseReportData } from "@/features/reports/schemas";

// PKG-07: the punch cards report's shaping, from the sample the database test 89 saved

const ORG = "00000000-0000-4000-8000-000000000099";
const sample = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/reports/report_punch_cards.json"), "utf8"));

function allowed(value: unknown) {
  const data = parseReportData("report_punch_cards", value);
  if (!data.allowed) throw new Error("expected an allowed answer");
  return data;
}

describe("punch cards report (PKG-07)", () => {
  it("is a report of the punch_cards plan key with no filters, for owners, admins and managers only", () => {
    const report = findReport("punch_cards")!;
    expect(report).toMatchObject({ feature: "punch_cards", filters: [], managers: true });
    expect(["owner", "admin", "manager", "member", "viewer", null].map((role) => reportRoleAllows(report, role))).toEqual([true, true, true, false, false, false]);
    // other reports are not limited by role
    expect(reportRoleAllows(findReport("revenue")!, "member")).toBe(true);
  });

  it("the expiring window is 7, 14, 30 or 60 days, 30 when nothing valid is kept (owner (117) ב)", () => {
    expect(PUNCH_DAYS_CHOICES).toEqual([7, 14, 30, 60]);
    expect(PUNCH_DAYS_DEFAULT).toBe(30);
    expect([7, 14, 30, 60, 0, 31, 366, "30", null].map(isPunchDays)).toEqual([true, true, true, true, false, false, false, false, false]);
    expect(punchDaysFromColumns([{ days: 14 }])).toBe(14);
    for (const bad of [null, [], [{ days: 31 }], [{ days: "7" }], [{ days: 7 }, { days: 14 }], { days: 7 }]) expect(punchDaysFromColumns(bad)).toBe(30);
    // the database's constraint holds the same closed list
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261006021169_punch_card_report.sql"), "utf8");
    for (const days of PUNCH_DAYS_CHOICES) expect(sql).toContain(`'[{"days": ${days}}]'::jsonb`);
  });

  it("shows active cards, utilisation, expiring cards and the money for entries not used yet", () => {
    const view = punchCardsView(ORG, allowed(sample));
    expect(view.note).toBeUndefined();
    expect(view.kpis.map((k) => k.label)).toEqual(["כרטיסיות פעילות", "ניצול כניסות", "פגות בתוך 30 יום", "כסף על שירות שעוד לא ניתן"]);
    expect(view.kpis[0].value).toBe("1");
    expect(view.kpis[1].value).toBe("0%");
    expect(view.sections.map((s) => s.title)).toEqual(["ניצול לפי מוצר", "פגות בתוך 30 יום", "כסף שהתקבל על שירות שעוד לא ניתן"]);
    expect(view.sections[0].rows[0]).toMatchObject({ product: "כרטיסייה 5", cards: 1, utilisation: 0, unearned: 23600 });
    expect(view.sections[1].rows[0]).toMatchObject({ customer: "מנויה", entries_left: 5, kind: "שולמה" });
    expect(view.sections[1].rows[0]._href).toBe(`/o/${ORG}/contacts/${sample.expiring_cards[0].contact_id}`);
    expect(view.sections[2].rows[0]).toMatchObject({ cards: 1, amount: 23600 });
    // manual and unpaid cards are counted, never with money
    expect(view.sections[2].rows.slice(2).every((r) => r.amount === null)).toBe(true);
  });

  it("a contact in the recycle bin is marked and not linked; an unpaid card says its payment stopped counting", () => {
    const data = allowed({ ...sample, expiring_cards: [{ ...sample.expiring_cards[0], contact_binned: true, kind: "unpaid" }] });
    const row = punchCardsView(ORG, data).sections[1].rows[0];
    expect(row._href).toBeNull();
    expect(row.customer).toBe(`מנויה (${BINNED_CONTACT})`);
    expect(row.kind).toBe("התשלום הפסיק להיספר");
  });

  it("the expired row counts only the paid cards its amount sums", () => {
    const data = allowed({ ...sample, totals: { ...sample.totals, expired_with_entries: 3, expired_paid_with_entries: 1, expired_value: 500 } });
    const row = punchCardsView(ORG, data).sections[2].rows[1];
    expect(row).toMatchObject({ measure: EXPIRED_ROW, cards: 1, amount: 500 });
    expect(EXPIRED_ROW).toBe("פג תוקף עם יתרה");
  });

  it("utilisation is shown in percent with one decimal", () => {
    const data = allowed({
      ...sample,
      totals: { ...sample.totals, entries_used: 1, entries_total: 3 },
      by_product: [{ ...sample.by_product[0], utilisation: 0.3333 }],
    });
    const view = punchCardsView(ORG, data);
    expect(view.kpis[1].value).toBe("33.3%");
    expect(view.sections[0].rows[0].utilisation).toBe(33.3);
  });

  it("a partial answer shows the counts with no money anywhere", () => {
    const data = allowed({
      ...sample,
      partial: true,
      totals: { ...sample.totals, unearned: null, expired_value: null },
      by_product: sample.by_product.map((p: Record<string, unknown>) => ({ ...p, unearned: null })),
    });
    const view = punchCardsView(ORG, data);
    expect(view.note).toBe(PUNCH_PARTIAL_NOTE);
    expect(view.kpis[3].value).toBe("—");
    expect(view.sections.map((s) => s.title)).toEqual(["ניצול לפי מוצר", "פגות בתוך 30 יום"]);
    expect(view.sections[0].columns.map((c) => c.key)).not.toContain("unearned");
    expect(view.sections[0].rows[0]).not.toHaveProperty("unearned");
  });

  it("an answer without the key is refused by the schema's other branch only", () => {
    expect(parseReportData("report_punch_cards", { allowed: false })).toEqual({ allowed: false });
  });
});
