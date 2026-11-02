import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  addMonths,
  customerStatusRule,
  dealsText,
  DEFAULT_DORMANT_MONTHS,
  DEFAULT_FORMER_MONTHS,
  DORMANT_MAX,
  DORMANT_MIN,
  FORMER_MAX,
  FORMER_MIN,
  monthsText,
  parseCustomerSummary,
  statusExplanation,
  thresholdProblems,
  type FullCustomerSummary,
  valueDetail,
} from "@/features/customer-status/status";

type Case = { name: string; last: string | null; today: string; dormant: number; former: number; status: string | null };
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/customer-status.json"), "utf8")) as { cases: Case[] };
const migrationsDir = path.resolve(__dirname, "../../supabase/migrations");
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith("_customer_status.sql"));
const migration = migrationFiles.length === 1 ? readFileSync(path.join(migrationsDir, migrationFiles[0]), "utf8") : "";

describe("customer status (CON-11)", () => {
  it("answers the shared fixture", () => {
    for (const c of fixture.cases) {
      expect(customerStatusRule(c.last, c.today, c.dormant, c.former), c.name).toBe(c.status);
    }
  });

  it("adds months the way PostgreSQL does", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
    expect(addMonths("2026-12-31", 120)).toBe("2036-12-31");
    expect(() => addMonths("2026-1-1", 1)).toThrow();
  });

  it("keeps the defaults and bounds equal to the migration", () => {
    expect(migrationFiles).toHaveLength(1);
    expect(migration).toContain(`dormant_months   smallint not null default ${DEFAULT_DORMANT_MONTHS}`);
    expect(migration).toContain(`former_months    smallint not null default ${DEFAULT_FORMER_MONTHS}`);
    expect(migration).toContain(`check (dormant_months between ${DORMANT_MIN} and ${DORMANT_MAX})`);
    expect(migration).toContain(`check (former_months between ${FORMER_MIN} and ${FORMER_MAX})`);
    expect(migration).toContain(`s.organization_id = p_org), ${DEFAULT_DORMANT_MONTHS})::integer,`);
    expect(migration).toContain(`s.organization_id = p_org), ${DEFAULT_FORMER_MONTHS})::integer`);
  });

  it("checks the settings form like the table", () => {
    expect(thresholdProblems(6, 18)).toBeNull();
    expect(thresholdProblems(0, 18)?.dormant_months).toBeTruthy();
    expect(thresholdProblems(61, 120)?.dormant_months).toBeTruthy();
    expect(thresholdProblems(6, 6)?.former_months).toBeTruthy();
    expect(thresholdProblems(6, 121)?.former_months).toBeTruthy();
    expect(thresholdProblems(1.5, 18)?.dormant_months).toBeTruthy();
  });

  it("reads every answer shape and refuses others", () => {
    expect(parseCustomerSummary({ allowed: false })).toEqual({ allowed: false });
    expect(parseCustomerSummary({ allowed: true, partial: true })).toEqual({ allowed: true, partial: true });
    expect(parseCustomerSummary({ allowed: true, partial: false, customer: false, dormant_months: 6, former_months: 18 })).toMatchObject({ customer: false });
    const full = parseCustomerSummary({
      allowed: true, partial: false, customer: true, status: "dormant", deals: 3, payments: 2, deals_without_amount: 1, value_agorot: "120000",
      first_purchase_on: "2024-01-01", last_purchase_on: "2025-01-01", dormant_on: "2025-07-01", former_on: "2026-07-01",
      today: "2026-01-01", dormant_months: 6, former_months: 18,
    }) as FullCustomerSummary;
    expect(full.value_agorot).toBe(120000);
    expect(statusExplanation(full)).toBe("לא קנה 6 חודשים ויותר");
    expect(statusExplanation({ ...full, status: "active" }, (d) => `[${d}]`)).toBe("ייחשב רדום אם לא יקנה עד [2025-07-01]");
    expect(() => parseCustomerSummary({ allowed: true, partial: false, customer: true, status: "sleepy" })).toThrow();
  });

  it("says what the value sums", () => {
    expect(valueDetail({ deals: 2, payments: 1 })).toBe("2 עסקאות שנסגרו בהצלחה");
    expect(valueDetail({ deals: 0, payments: 3 })).toBe("אין עסקה שנסגרה בהצלחה, רק תשלומים");
  });

  it("words counts", () => {
    expect(dealsText(1)).toBe("עסקה אחת");
    expect(dealsText(4)).toBe("4 עסקאות");
    expect(monthsText(1)).toBe("חודש");
    expect(monthsText(2)).toBe("חודשיים");
    expect(monthsText(18)).toBe("18 חודשים");
  });
});
