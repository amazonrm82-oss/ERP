// USR-09 (owner (387) א): the OPS-04 handler of invite.send. Pure of the database: it gets the composer
// (public.invitation_job_compose, service_role, on the job's live lease) and the email channel's provider, and sends the fixed
// invitation text. Every check lives in the composer (the invitation still pending and not expired, the business writable,
// the person who asked still an owner or admin); a refusal sends nothing and ends the job. The queue holds ids only; the
// token the composer mints goes into the link alone and is never logged or kept.

import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";
import type { MessagingProvider } from "@/features/messaging/providers/types";
import type { MembershipRole } from "@/lib/database.types";
import { paths } from "@/lib/paths";

import { buildInvitationEmail } from "./email";
import { isInvitationToken } from "./token";

export type InvitationComposed =
  | { ok: true; to: string; businessName: string; role: MembershipRole; expiresAt: string; token: string }
  | { ok: false; code: string };

const CODE = /^[a-z_]{1,40}$/;
const ROLES: MembershipRole[] = ["admin", "manager", "member", "viewer"];

export function parseInvitationComposed(data: unknown): InvitationComposed | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.refused === "string") return CODE.test(r.refused) ? { ok: false, code: r.refused } : null;
  if (typeof r.to !== "string" || typeof r.business_name !== "string" || typeof r.expires_at !== "string") return null;
  if (!ROLES.includes(r.role as MembershipRole) || !isInvitationToken(r.token)) return null;
  return { ok: true, to: r.to, businessName: r.business_name, role: r.role as MembershipRole, expiresAt: r.expires_at, token: r.token };
}

export function createInvitationHandler(deps: {
  compose: (job: ClaimedJob) => Promise<unknown>;
  provider: MessagingProvider;
  siteOrigin: () => string;
}): JobHandler {
  return async (job) => {
    const origin = deps.siteOrigin();
    if (!/^https?:\/\/[^\s/]+$/.test(origin)) return { status: "failed", error: "site url missing" };
    const composed = parseInvitationComposed(await deps.compose(job));
    if (!composed) return { status: "failed", error: "compose answered an unexpected shape" };
    if (!composed.ok) {
      if (composed.code === "stale") return { status: "failed", error: "stale lease" };
      return { status: "failed", error: `refused ${composed.code}`, final: true, receipt: { provider: null, errorCode: composed.code } };
    }
    const link = `${origin}${paths.invite(composed.token)}`;
    const email = buildInvitationEmail({ businessName: composed.businessName, role: composed.role, expiresAt: composed.expiresAt, link });
    if (!email) return { status: "failed", error: "bad invitation", final: true, receipt: { provider: null, errorCode: "bad_invitation" } };
    const result = await deps.provider.send({
      jobId: job.id,
      organizationId: job.organization_id,
      channel: "email",
      messageType: null,
      purpose: "service",
      recordType: "invitation",
      recordId: typeof job.payload.invitation_id === "string" ? job.payload.invitation_id : "",
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
