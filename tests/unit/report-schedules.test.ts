import { describe, expect, it } from "vitest";

import { frequencyText, SCHEDULE_CATALOG, SCHEDULE_PERIODS, SCHEDULE_TIMES } from "@/features/report-schedules/catalog";
import { buildReportEmail, reportDateLabel, reportLinkPath } from "@/features/report-schedules/email";
import { createReportHandler, parseReportComposed } from "@/features/report-schedules/send-handler";
import type { OutgoingMessage } from "@/features/messaging/providers/types";
import { REPORTS } from "@/features/reports/definitions";
import { resolveTerms } from "@/features/terminology/terms";

import { latestMigrationText } from "./helpers/migrations";

// RPT-03 (owner (386) א): the email holds only the report's name, the period and a link; the catalog mirrors the database's.

describe("the catalog", () => {
  it("mirrors app.scheduled_report_catalog() of the latest migration, one row per report definition", () => {
    const sql = latestMigrationText("function app.scheduled_report_catalog()") ?? "";
    const block = sql.split("-- scheduled-report-catalog")[1]?.split("-- end scheduled-report-catalog")[0] ?? "";
    const rows = [...block.matchAll(/\('([a-z_]+)', (true|false), '\{([a-z_,]*)\}'::text\[\], (true|false), (null|'leads'), (true|false)\)/g)].map((m) => ({
      key: m[1],
      hasPeriod: m[2] === "true",
      features: m[3] ? m[3].split(",") : [],
      restricted: m[4] === "true",
      module: m[5] === "null" ? null : "leads",
      costs: m[6] === "true",
    }));
    expect(rows).toEqual(SCHEDULE_CATALOG);
    expect(SCHEDULE_CATALOG.map((e) => e.key)).toEqual(REPORTS.map((r) => r.key));
  });

  it("the cost reports are restricted and need cost rights (review fix 6)", () => {
    for (const key of ["categories", "campaign_roi", "profit"]) {
      expect(SCHEDULE_CATALOG.find((e) => e.key === key), key).toMatchObject({ restricted: true, costs: true });
    }
    expect(SCHEDULE_CATALOG.find((e) => e.key === "revenue")).toMatchObject({ restricted: false, costs: false });
  });

  it("the periods and the times are the database's closed lists", () => {
    const sql = latestMigrationText("create table if not exists public.report_schedules") ?? "";
    for (const p of SCHEDULE_PERIODS) expect(sql).toContain(`'${p.value}'`);
    expect(SCHEDULE_TIMES[0]).toBe("06:00");
    expect(SCHEDULE_TIMES.at(-1)).toBe("22:00");
    expect(SCHEDULE_TIMES).toHaveLength(65);
    expect(frequencyText("weekly", 1, "08:00:00")).toBe("כל יום שני ב-08:00");
    expect(frequencyText("daily", null, "07:45")).toBe("כל יום עבודה ב-07:45");
  });
});

describe("the email", () => {
  const links = { report: "https://mexuzsystem.com/o/x/reports/revenue?period=custom&from=2026-11-09&to=2026-11-15", settings: "https://mexuzsystem.com/o/x/reports/scheduled" };

  it("holds the report's name, the period and the link, and no number of the report", () => {
    const mail = buildReportEmail({ businessName: "עסק‮ לדוגמה", reportKey: "revenue", period: "last_7", fromDate: "2026-11-09", toDate: "2026-11-15", links })!;
    expect(mail.subject).toBe("דוח מתוזמן: הכנסות (7 הימים האחרונים)");
    expect(mail.text).toContain('הדוח "הכנסות" של עסק לדוגמה מוכן לצפייה.');
    expect(mail.text).toContain("תקופה: 9 בנובמבר 2026 עד 15 בנובמבר 2026");
    expect(mail.text).toContain(links.report);
    expect(mail.text).not.toContain("‮");
    expect(mail.links).toEqual([links.report, links.settings]);
    // the only digits in the text are those of the dates and the links
    const withoutLinks = mail.text.replace(links.report, "").replace(links.settings, "").replace(/\d{1,2} ב[א-ת]+ \d{4}/g, "");
    expect(withoutLinks).not.toMatch(/\d/);
  });

  it("names the report in the business's own words (delta review 4)", () => {
    const terms = resolveTerms({ contact: null, lead: "inquiry", deal: null });
    const mail = buildReportEmail({ businessName: "ע", reportKey: "sources", period: "last_7", fromDate: "2026-11-09", toDate: "2026-11-15", terms, links })!;
    expect(mail.subject).toBe("דוח מתוזמן: פניות לפי מקור (7 הימים האחרונים)");
    expect(mail.text).toContain('הדוח "פניות לפי מקור"');
    expect(buildReportEmail({ businessName: "ע", reportKey: "sources", period: "last_7", fromDate: "2026-11-09", toDate: "2026-11-15", links })!.subject).toContain("לידים לפי מקור");
  });

  it("a report without a period says the current state; an unknown report or a broken period builds nothing", () => {
    expect(buildReportEmail({ businessName: "ע", reportKey: "stuck", period: null, fromDate: null, toDate: null, links })!.text).toContain("תקופה: מצב נוכחי");
    expect(buildReportEmail({ businessName: "ע", reportKey: "nope", period: null, fromDate: null, toDate: null, links })).toBeNull();
    expect(buildReportEmail({ businessName: "ע", reportKey: "revenue", period: "last_7", fromDate: "x", toDate: null, links })).toBeNull();
    expect(buildReportEmail({ businessName: "ע", reportKey: "revenue", period: "yesterday", fromDate: "2026-11-15", toDate: "2026-11-15", links })!.text).toContain("תקופה: 15 בנובמבר 2026\n");
  });

  it("the link carries the period as the report page's own custom range", () => {
    expect(reportLinkPath("o1", "revenue", "2026-11-09", "2026-11-15")).toBe("/o/o1/reports/revenue?period=custom&from=2026-11-09&to=2026-11-15");
    expect(reportLinkPath("o1", "stuck", null, null)).toBe("/o/o1/reports/stuck");
    expect(reportDateLabel("2026-02-30")).toBeNull();
  });
});

describe("the report.send handler", () => {
  const org = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const job = { id: "11111111-2222-4333-8444-555555555555", lease: "l", kind: "report.send" as const, organization_id: org, payload: { user_id: "u", schedule_id: "s", day: "2026-11-16" }, attempt: 1 };
  const answer = { to: "rep@example.com", business_name: "עסק", report_key: "revenue", period: "last_7", from_date: "2026-11-09", to_date: "2026-11-15", day: "2026-11-16" };

  it("parses only the composer's own shape", () => {
    expect(parseReportComposed(answer)).toMatchObject({ ok: true, reportKey: "revenue", fromDate: "2026-11-09" });
    const withTerms = parseReportComposed({ ...answer, report_key: "sources", terms: { lead_term: "prospect", deal_term: "bogus" } });
    expect(withTerms && withTerms.ok ? [withTerms.terms.lead.plural, withTerms.terms.deal.singular] : null).toEqual(["מתעניינים", "עסקה"]);
    expect(parseReportComposed({ refused: "not_recipient" })).toEqual({ ok: false, code: "not_recipient" });
    expect(parseReportComposed({ ...answer, from_date: "9/11" })).toBeNull();
    expect(parseReportComposed({ ...answer, report_key: "Revenue!" })).toBeNull();
    expect(parseReportComposed(null)).toBeNull();
  });

  it("sends one email with the link and no unsubscribe header, and ends a refusal without sending", async () => {
    const sent: OutgoingMessage[] = [];
    const provider = { name: "fake", channel: "email" as const, send: async (m: OutgoingMessage) => (sent.push(m), { ok: true as const, providerId: "p1" }) };
    const done = await createReportHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => answer })(job);
    expect(done).toEqual({ status: "done", receipt: { provider: "fake", providerMessageId: "p1" } });
    const mail = sent[0].emailContent!;
    expect(mail.to).toBe("rep@example.com");
    expect(mail.text).toContain(`https://mexuzsystem.com/o/${org}/reports/revenue?period=custom&from=2026-11-09&to=2026-11-15`);
    expect(mail.text).toContain(`https://mexuzsystem.com/o/${org}/reports/scheduled`);
    expect(mail.listUnsubscribe).toBeNull();
    expect(mail.attachments).toEqual([]);
    const refused = await createReportHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => ({ refused: "switched_off" }) })(job);
    expect(refused).toMatchObject({ status: "failed", final: true, receipt: { provider: null, errorCode: "switched_off" } });
    const stale = await createReportHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => ({ refused: "stale" }) })(job);
    expect(stale).toEqual({ status: "failed", error: "stale lease" });
    let asked = false;
    expect(await createReportHandler({ provider, siteOrigin: () => "", compose: async () => ((asked = true), answer) })(job)).toMatchObject({ status: "failed" });
    expect(asked).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
