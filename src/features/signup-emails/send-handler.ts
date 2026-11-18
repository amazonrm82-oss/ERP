// WEB-05 (owner (418) ב): the OPS-04 handler of signup.send. Pure of the database: it gets the composer
// (public.signup_job_compose, service_role, on the job's live lease) and the email channel's provider, and sends the fixed
// service text. Every check lives in the composer (the business open, still on its trial for trial_ending, the person still its active
// owner, the trial not over); a refusal sends nothing and ends the job. The queue holds ids and a kind only.

import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";
import type { MessagingProvider } from "@/features/messaging/providers/types";
import { paths } from "@/lib/paths";

import { buildSignupEmail, SIGNUP_EMAIL_KINDS, type SignupEmailKind } from "./email";

export type SignupComposed =
  | { ok: true; to: string; firstName: string | null; businessName: string; kind: SignupEmailKind; trialEndDay: string | null }
  | { ok: false; code: string };

const CODE = /^[a-z_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseSignupComposed(data: unknown): SignupComposed | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.refused === "string") return CODE.test(r.refused) ? { ok: false, code: r.refused } : null;
  if (typeof r.to !== "string" || typeof r.business_name !== "string") return null;
  const first = r.first_name;
  if (first !== null && first !== undefined && typeof first !== "string") return null;
  if (!(SIGNUP_EMAIL_KINDS as readonly unknown[]).includes(r.kind)) return null;
  const day = r.trial_end_day;
  if (day !== null && day !== undefined && (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))) return null;
  return {
    ok: true,
    to: r.to,
    firstName: typeof first === "string" ? first : null,
    businessName: r.business_name,
    kind: r.kind as SignupEmailKind,
    trialEndDay: typeof day === "string" ? day : null,
  };
}

export function createSignupHandler(deps: {
  compose: (job: ClaimedJob) => Promise<unknown>;
  provider: MessagingProvider;
  siteOrigin: () => string;
}): JobHandler {
  return async (job) => {
    const origin = deps.siteOrigin();
    if (!/^https?:\/\/[^\s/]+$/.test(origin)) return { status: "failed", error: "site url missing" };
    if (!UUID.test(job.organization_id)) return { status: "failed", error: "bad job", final: true, receipt: { provider: null, errorCode: "invalid" } };
    const composed = parseSignupComposed(await deps.compose(job));
    if (!composed) return { status: "failed", error: "compose answered an unexpected shape" };
    if (!composed.ok) {
      if (composed.code === "stale") return { status: "failed", error: "stale lease" };
      return { status: "failed", error: `refused ${composed.code}`, final: true, receipt: { provider: null, errorCode: composed.code } };
    }
    const org = job.organization_id;
    const email = buildSignupEmail({
      kind: composed.kind,
      firstName: composed.firstName,
      businessName: composed.businessName,
      trialEndDay: composed.trialEndDay,
      links: {
        business: `${origin}${paths.org(org)}`,
        plan: `${origin}${paths.settingsPlan(org)}`,
        users: `${origin}${paths.settingsUsers(org)}`,
        intake: `${origin}${paths.settingsIntake(org)}`,
        imports: `${origin}${paths.imports(org)}`,
      },
    });
    if (!email) return { status: "failed", error: "bad signup email", final: true, receipt: { provider: null, errorCode: "bad_email" } };
    const result = await deps.provider.send({
      jobId: job.id,
      organizationId: job.organization_id,
      channel: "email",
      messageType: null,
      purpose: "service",
      recordType: "user",
      recordId: typeof job.payload.user_id === "string" ? job.payload.user_id : "",
      emailContent: {
        to: composed.to,
        fromName: "מקסוז",
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
