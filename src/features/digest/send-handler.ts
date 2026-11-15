// USR-11 / WAB-03 / MNY-03: the OPS-04 handler of digest.send. Pure of the database: it gets the composer (public.digest_job_compose,
// service_role, on the job's live lease) and the email channel's provider, and sends one email built by buildDigestEmail.
// Every check lives in the composer (the plan key, the person's switch and the stop link, an active member, an open business,
// the job's day): a refusal sends nothing and ends the job. The queue holds ids only; the address, the counts and the token are
// never logged or kept.

import { paths } from "@/lib/paths";

import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";
import type { MessagingProvider } from "@/features/messaging/providers/types";

import { buildDigestEmail, digestCountsFrom, digestDayLabel } from "./email";
import { DIGEST_STOP_TOKEN, digestStopPagePath, digestStopSubmitPath } from "./stop";

export type DigestComposed =
  | { ok: true; to: string; businessName: string; day: string; kind: "manager" | "personal"; counts: unknown; stopToken: string }
  | { ok: false; code: string };

const CODE = /^[a-z_]{1,40}$/;

/** public.digest_job_compose's answer, or null for a shape that is not its own. */
export function parseDigestComposed(data: unknown): DigestComposed | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.refused === "string") return CODE.test(r.refused) ? { ok: false, code: r.refused } : null;
  if (typeof r.to !== "string" || typeof r.business_name !== "string" || typeof r.day !== "string") return null;
  if (r.kind !== "manager" && r.kind !== "personal") return null;
  if (typeof r.stop_token !== "string" || !DIGEST_STOP_TOKEN.test(r.stop_token)) return null;
  return { ok: true, to: r.to, businessName: r.business_name, day: r.day, kind: r.kind, counts: r.counts ?? null, stopToken: r.stop_token };
}

export function createDigestHandler(deps: {
  compose: (job: ClaimedJob) => Promise<unknown>;
  provider: MessagingProvider;
  siteOrigin: () => string;
}): JobHandler {
  return async (job) => {
    const origin = deps.siteOrigin();
    // the links need the site's address; without it the job waits and is tried again
    if (!/^https?:\/\/[^\s/]+$/.test(origin)) return { status: "failed", error: "site url missing" };
    const composed = parseDigestComposed(await deps.compose(job));
    if (!composed) return { status: "failed", error: "compose answered an unexpected shape" };
    if (!composed.ok) {
      if (composed.code === "stale") return { status: "failed", error: "stale lease" };
      return { status: "failed", error: `refused ${composed.code}`, final: true, receipt: { provider: null, errorCode: composed.code } };
    }
    const dayLabel = digestDayLabel(composed.day);
    if (!dayLabel) return { status: "failed", error: "bad day", final: true };
    const org = job.organization_id;
    const at = (path: string) => `${origin}${path}`;
    const email = buildDigestEmail({
      kind: composed.kind,
      businessName: composed.businessName,
      dayLabel,
      counts: digestCountsFrom(composed.counts),
      links: {
        myDay: at(paths.org(org)),
        leadsWaiting: at(paths.leadsWaiting(org)),
        tasks: at(paths.tasks(org)),
        moneyWaiting: at(paths.moneyWaiting(org)),
        settings: at(`${paths.settingsAccount(org)}#account-notifications`),
        stop: at(digestStopPagePath(composed.stopToken)),
      },
    });
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
        // RFC 8058: a mail program's one-click stop posts here
        listUnsubscribe: at(digestStopSubmitPath(composed.stopToken)),
        links: email.links,
        attachments: [],
      },
    });
    if (result.ok) return { status: "done", receipt: { provider: deps.provider.name, providerMessageId: result.providerId } };
    return {
      status: "failed",
      error: result.error,
      final: result.final === true,
      receipt: { provider: deps.provider.name, errorCode: result.code },
    };
  };
}
