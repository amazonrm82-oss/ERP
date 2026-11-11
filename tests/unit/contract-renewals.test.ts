import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { documentTemplateSchema } from "@/features/document-templates/schema";
import {
  addCalendarDays,
  CONTRACT_RENEWAL_DEFAULT,
  CONTRACT_RENEWAL_MAX,
  contractExpired,
  contractRenewalDaysOf,
  contractRenewalLabel,
  contractRenewalSchema,
  DEFAULT_VALIDITY_MAX,
  defaultValidityLabel,
  endsSoon,
  EXPIRED_LIST_DAYS,
  recentlyExpired,
  renewalTarget,
  validityLine,
  validityEnd,
  validitySchema,
} from "@/features/signatures/validity";

import VALIDITY_ENDS from "./fixtures/contract-validity-end.json";
import { dbErrorMessage, GENERIC_ERROR } from "@/lib/errors";

const dir = join(process.cwd(), "supabase/migrations");
const sql = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith("_contract_renewals.sql"))!), "utf8");

describe("SGN-04 contract validity (pure rules)", () => {
  it("the lead time: default and bounds match the migration", () => {
    expect(sql).toContain(`contract_renewal_days smallint not null default ${CONTRACT_RENEWAL_DEFAULT}`);
    expect(sql).toContain(`check (contract_renewal_days between 0 and ${CONTRACT_RENEWAL_MAX})`);
    expect(sql).toContain(`default_validity_months between 1 and ${DEFAULT_VALIDITY_MAX}`);
    expect(contractRenewalDaysOf(45)).toBe(45);
    expect(contractRenewalDaysOf(0)).toBe(0);
    expect(contractRenewalDaysOf(366)).toBe(30);
    expect(contractRenewalDaysOf(null)).toBe(30);
    expect(contractRenewalLabel(0)).toBe("בלי התראה");
    expect(contractRenewalLabel(30)).toBe("30 ימים לפני");
    expect(contractRenewalSchema.safeParse({ contract_renewal_days: "366" }).success).toBe(false);
    expect(contractRenewalSchema.safeParse({ contract_renewal_days: "14" }).data).toEqual({ contract_renewal_days: 14 });
  });

  it("the labels of the template default", () => {
    expect(defaultValidityLabel(null)).toBe("בלי תוקף קבוע");
    expect(defaultValidityLabel(12)).toBe("שנה");
    expect(defaultValidityLabel(36)).toBe("3 שנים");
    expect(defaultValidityLabel(6)).toBe("6 חודשים");
  });

  it("the line on the card and the target day", () => {
    expect(validityLine(null, null)).toBeNull();
    expect(validityLine("2027-10-31", null)).toBe("בתוקף עד 31.10.2027");
    expect(validityLine("2027-10-31", "2027-10-01")).toBe("בתוקף עד 31.10.2027 · חידוש ב-01.10.2027");
    expect(renewalTarget("2027-10-31", "2027-10-01")).toBe("2027-10-01");
    expect(renewalTarget("2027-10-31", null)).toBe("2027-10-31");
    expect(renewalTarget(null, "2027-10-01")).toBeNull();
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("ending soon = the job's window: target minus the lead time reached, last day not passed", () => {
    expect(endsSoon("2026-12-10", null, "2026-11-11", 30)).toBe(true);
    expect(endsSoon("2026-12-12", null, "2026-11-11", 30)).toBe(false);
    expect(endsSoon("2027-06-01", "2026-12-01", "2026-11-11", 30)).toBe(true);
    expect(endsSoon("2026-11-10", null, "2026-11-11", 30)).toBe(false);
    expect(endsSoon("2026-11-11", null, "2026-11-11", 30)).toBe(true);
    // with the alert off, the list still shows the next 30 days
    expect(endsSoon("2026-12-10", null, "2026-11-11", 0)).toBe(true);
    expect(endsSoon(null, null, "2026-11-11", 30)).toBe(false);
    // the SQL rule is the same comparison
    expect(sql).toContain("and d.valid_until >= og.today");
    expect(sql).toContain("and coalesce(d.renewal_on, d.valid_until) - og.days <= og.today");
  });

  it("owner (278) ב: a contract past its last day is expired, and listed for 90 days", () => {
    expect(EXPIRED_LIST_DAYS).toBe(90);
    expect(contractExpired("2026-11-10", "2026-11-11")).toBe(true);
    expect(contractExpired("2026-11-11", "2026-11-11")).toBe(false);
    expect(contractExpired(null, "2026-11-11")).toBe(false);
    expect(recentlyExpired("2026-08-13", "2026-11-11")).toBe(true);
    expect(recentlyExpired("2026-08-12", "2026-11-11")).toBe(false);
    expect(recentlyExpired("2026-11-11", "2026-11-11")).toBe(false);
    // an expired contract is not "ending soon"
    expect(endsSoon("2026-11-10", null, "2026-11-11", 30)).toBe(false);
  });

  it("the dates form: empty = none, renewal needs a last day and is not after it", () => {
    expect(validitySchema.safeParse({ valid_until: "", renewal_on: "" }).data).toEqual({ validUntil: null, renewalOn: null });
    expect(validitySchema.safeParse({ valid_until: "2027-01-31", renewal_on: "2027-01-01" }).data).toEqual({ validUntil: "2027-01-31", renewalOn: "2027-01-01" });
    expect(validitySchema.safeParse({ valid_until: "", renewal_on: "2027-01-01" }).success).toBe(false);
    expect(validitySchema.safeParse({ valid_until: "2027-01-01", renewal_on: "2027-01-02" }).success).toBe(false);
    expect(validitySchema.safeParse({ valid_until: "2027-02-30", renewal_on: "" }).success).toBe(false);
  });

  it("the template form takes the default validity: empty = none, 1..120", () => {
    const base = { name: "חוזה", kind: "contract", record_type: "contact", body: "נוסח", is_active: "on" };
    expect(documentTemplateSchema.safeParse({ ...base, default_validity_months: "" }).data?.default_validity_months).toBeNull();
    expect(documentTemplateSchema.safeParse({ ...base, default_validity_months: "12" }).data?.default_validity_months).toBe(12);
    expect(documentTemplateSchema.safeParse({ ...base, default_validity_months: "121" }).success).toBe(false);
    expect(documentTemplateSchema.safeParse({ ...base, default_validity_months: "0" }).success).toBe(false);
  });

  it("the last day of N months (shared fixture with the database)", () => {
    for (const c of VALIDITY_ENDS) expect(validityEnd(c.day, c.months), `${c.day} + ${c.months}`).toBe(c.end);
    expect(sql).toContain("app.contract_validity_end((coalesce(new.signed_at, now()) at time zone v_zone)::date, v_months)");
  });

  it("the renewal task's text holds dates only, never the document's title (delta review)", () => {
    const start = sql.indexOf("create or replace function app.contract_renewal_task_text");
    const body = sql.slice(start, sql.indexOf("$$;", start));
    expect(start).toBeGreaterThan(0);
    expect(body).not.toContain("p_doc.title");
    expect(body).toContain("'לחדש חוזה שנחתם ב-'");
  });

  it("every hint of the migration has a message", () => {
    const hints = [...sql.matchAll(/hint = '(signature_document:validity_[a-z]+)'/g)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThanOrEqual(4);
    for (const hint of hints) expect(dbErrorMessage({ code: "P0001", message: "x", hint }), hint).not.toBe(GENERIC_ERROR);
  });
});
