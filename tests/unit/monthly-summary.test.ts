import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SUMMARY_FAILED_MESSAGE,
  SUMMARY_TIMEOUT_MESSAGE,
  monthLabel,
  nextMonth,
  previousMonth,
  summaryLines,
  summaryLoadMessage,
  summaryMonth,
  type MonthlySummary,
} from "@/features/monthly-summary/summary";
import { parseReportData } from "@/features/reports/schemas";
import { DEFAULT_TERM_KEYS, resolveTerms } from "@/features/terminology/terms";

const sample = parseReportData(
  "report_monthly_summary",
  JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/reports/report_monthly_summary.json"), "utf8")),
) as MonthlySummary;
const terms = resolveTerms(DEFAULT_TERM_KEYS);
const plain = (n: number) => String(n);

describe("monthly summary (MNY-06)", () => {
  it("takes only this month or an earlier one from ?month=", () => {
    expect(summaryMonth("2026-10", "2026-11-12")).toBe("2026-10-01");
    expect(summaryMonth("2026-11", "2026-11-12")).toBe("2026-11-01");
    expect(summaryMonth("2026-12", "2026-11-12")).toBeNull();
    expect(summaryMonth("2026-13", "2026-11-12")).toBeNull();
    expect(summaryMonth("1999-12", "2026-11-12")).toBeNull();
    expect(summaryMonth("2026-1", "2026-11-12")).toBeNull();
    expect(summaryMonth(undefined, "2026-11-12")).toBeNull();
    expect(summaryMonth(["2026-09", "2026-08"], "2026-11-12")).toBe("2026-09-01");
  });

  it("a failed read is a short line that keeps the reports page open (review)", () => {
    expect(summaryLoadMessage({ code: "57014" })).toBe(SUMMARY_TIMEOUT_MESSAGE);
    expect(summaryLoadMessage({ code: "22023" })).toBe(SUMMARY_FAILED_MESSAGE);
    expect(summaryLoadMessage(null)).toBe(SUMMARY_FAILED_MESSAGE);
  });

  it("moves between months and never past this one", () => {
    expect(previousMonth("2026-01-01")).toBe("2025-12");
    expect(previousMonth("2026-11-01")).toBe("2026-10");
    expect(nextMonth("2026-10-01", "2026-11-12")).toBe("2026-11");
    expect(nextMonth("2026-11-01", "2026-11-12")).toBeNull();
    expect(nextMonth("2025-12-01", "2026-11-12")).toBe("2026-01");
    expect(monthLabel("2026-11-01")).toBe("נובמבר 2026");
  });

  it("shows only what happened, counts only", () => {
    const lines = summaryLines(sample, terms, plain);
    expect(lines.map((l) => [l.key, l.value])).toEqual([
      ["leads", 2],
      ["instant_replies", 1],
      ["collected", 1],
    ]);
    expect(lines[0].label).toBe("לידים שחולקו אוטומטית");
    expect(lines.find((l) => l.key === "collected")).toMatchObject({ label: "חובות ששולמו עד 14 יום אחרי תזכורת", note: "בתשלום אחד" });
    expect(lines.find((l) => l.key === "instant_replies")?.note).toBeNull();
  });

  it("a sent message gets its note, and an empty month has no lines", () => {
    const sent = { ...sample, customer_messages: { ...sample.customer_messages, instant_reply: { queued: 3, sent: 2 } } };
    expect(summaryLines(sent, terms, plain).find((l) => l.key === "instant_replies")?.note).toBe("נשלחו 2");
    const empty: MonthlySummary = {
      ...sample,
      leads_distributed: 0,
      customer_messages: { ...sample.customer_messages, instant_reply: { queued: 0, sent: 0 } },
      collected_after_reminder: { window_days: 14, documents: 0, payments: 0 },
    };
    expect(summaryLines(empty, terms, plain)).toEqual([]);
  });
});
