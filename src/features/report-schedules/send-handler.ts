// RPT-03 (owner (386) א): the OPS-04 handler of report.send. Pure of the database: it gets the composer
// (public.scheduled_report_compose, service_role, on the job's live lease) and the email channel's provider, and sends one email
// built by buildReportEmail: the report's name, the period and a link, never a number. Every check lives in the composer
// (the business, the schedule and its switch, the report's availability, the recipient's membership and role, the day): a
// refusal sends nothing and ends the job. The queue holds ids only; the address is never logged or kept.

import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";
import type { MessagingProvider } from "@/features/messaging/providers/types";

import { resolveTerms, termKeys, type OrgTerms } from "@/features/terminology/terms";

import { buildReportEmail, reportLinkPath } from "./email";
import { reportSchedulesPath } from "./paths";

export type ReportComposed =
  | { ok: true; to: string; businessName: string; terms: OrgTerms; reportKey: string; period: string | null; fromDate: string | null; toDate: string | null }
  | { ok: false; code: string };

const CODE = /^[a-z_]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z_]{1,40}$/;

const dayOrNull = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : typeof v === "string" && DAY.test(v) ? v : undefined);

/** public.scheduled_report_compose's answer, or null for a shape that is not its own. */
export function parseReportComposed(data: unknown): ReportComposed | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.refused === "string") return CODE.test(r.refused) ? { ok: false, code: r.refused } : null;
  if (typeof r.to !== "string" || typeof r.business_name !== "string" || typeof r.report_key !== "string" || !KEY.test(r.report_key)) return null;
  const period = r.period === null || r.period === undefined ? null : typeof r.period === "string" && /^[a-z0-9_]{1,40}$/.test(r.period) ? r.period : undefined;
  const fromDate = dayOrNull(r.from_date);
  const toDate = dayOrNull(r.to_date);
  if (period === undefined || fromDate === undefined || toDate === undefined) return null;
  const rawTerms = r.terms && typeof r.terms === "object" && !Array.isArray(r.terms) ? (r.terms as Record<string, string | null>) : null;
  return { ok: true, to: r.to, businessName: r.business_name, terms: resolveTerms(termKeys(rawTerms)), reportKey: r.report_key, period, fromDate, toDate };
}

export function createReportHandler(deps: {
  compose: (job: ClaimedJob) => Promise<unknown>;
  provider: MessagingProvider;
  siteOrigin: () => string;
}): JobHandler {
  return async (job) => {
    const origin = deps.siteOrigin();
    if (!/^https?:\/\/[^\s/]+$/.test(origin)) return { status: "failed", error: "site url missing" };
    const composed = parseReportComposed(await deps.compose(job));
    if (!composed) return { status: "failed", error: "compose answered an unexpected shape" };
    if (!composed.ok) {
      if (composed.code === "stale") return { status: "failed", error: "stale lease" };
      return { status: "failed", error: `refused ${composed.code}`, final: true, receipt: { provider: null, errorCode: composed.code } };
    }
    const org = job.organization_id;
    const email = buildReportEmail({
      businessName: composed.businessName,
      reportKey: composed.reportKey,
      terms: composed.terms,
      period: composed.period,
      fromDate: composed.fromDate,
      toDate: composed.toDate,
      links: {
        report: `${origin}${reportLinkPath(org, composed.reportKey, composed.fromDate, composed.toDate)}`,
        settings: `${origin}${reportSchedulesPath(org)}`,
      },
    });
    if (!email) return { status: "failed", error: "unknown report", final: true, receipt: { provider: null, errorCode: "unknown_report" } };
    const result = await deps.provider.send({
      jobId: job.id,
      organizationId: org,
      channel: "email",
      messageType: null,
      purpose: "service",
      recordType: "user",
      recordId: typeof job.payload.user_id === "string" ? job.payload.user_id : "",
      emailContent: {
        to: composed.to,
        fromName: composed.businessName,
        subject: email.subject,
        text: email.text,
        replyTo: null,
        listUnsubscribe: null,
        links: email.links,
        attachments: [],
      },
    });
    if (result.ok) return { status: "done", receipt: { provider: deps.provider.name, providerMessageId: result.providerId } };
    return { status: "failed", error: result.error, final: result.final === true, receipt: { provider: deps.provider.name, errorCode: result.code } };
  };
}
