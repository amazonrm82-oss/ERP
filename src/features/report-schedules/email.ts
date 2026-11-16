// RPT-03 (owner (386) א): the text of a scheduled report email. Pure. It holds ONLY the report's name, the period and a link
// to the report page with the period in the address: never a number of the report (the recipient opens the link with their
// own sign-in and sees what their rights allow). The wording is a DRAFT until the owner approves it.

import { findReport, reportTexts } from "@/features/reports/definitions";
import { DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";

import { periodLabel } from "./catalog";

export type ReportEmailInput = {
  businessName: string;
  reportKey: string;
  period: string | null;
  fromDate: string | null;
  toDate: string | null;
  /** the business's own words (FLD-10); today's words when left out */
  terms?: OrgTerms;
  /** absolute https links, made by the sender from NEXT_PUBLIC_SITE_URL */
  links: { report: string; settings: string };
};

export type ReportEmail = { subject: string; text: string; links: string[] };

/** A business name as one line: no control characters, at most 80 characters. */
function cleanName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return (flat || "העסק").slice(0, 80);
}

/** "YYYY-MM-DD" as "9 בנובמבר 2026"; null for anything else. */
export function reportDateLabel(day: string | null): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/** The report page's address with the period in it (the page's own custom range), or the page alone. */
export function reportLinkPath(orgId: string, reportKey: string, fromDate: string | null, toDate: string | null): string {
  const base = `/o/${orgId}/reports/${reportKey}`;
  if (!fromDate || !toDate) return base;
  return `${base}?${new URLSearchParams({ period: "custom", from: fromDate, to: toDate }).toString()}`;
}

/** null when the report is not one the app knows (the email is then not sent). */
export function buildReportEmail(input: ReportEmailInput): ReportEmail | null {
  const report = findReport(input.reportKey);
  if (!report) return null;
  const title = reportTexts(report, input.terms ?? DEFAULT_TERMS).title;
  const business = cleanName(input.businessName);
  const from = reportDateLabel(input.fromDate);
  const to = reportDateLabel(input.toDate);
  const periodText = from && to ? (from === to ? from : `${from} עד ${to}`) : input.period ? null : "מצב נוכחי";
  if (!periodText) return null;
  const subject = `דוח מתוזמן: ${title} (${input.period ? periodLabel(input.period) : "מצב נוכחי"})`.slice(0, 255);
  const text = [
    "שלום,",
    `הדוח "${title}" של ${business} מוכן לצפייה.`,
    `תקופה: ${periodText}`,
    "",
    `לצפייה בדוח: ${input.links.report}`,
    "הדוח נפתח אחרי כניסה למקסוז, ומציג רק את מה שמותר לכם לראות.",
    "",
    "—",
    `קיבלתם את המייל הזה כי נוספתם לדוח מתוזמן ב${business}.`,
    `להפסקת הקבלה או לשינוי: ${input.links.settings}`,
  ].join("\n");
  return { subject, text, links: [input.links.report, input.links.settings] };
}
