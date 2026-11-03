import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";

import { isMessageChannel, type MessageChannel, type MessagingProvider } from "./providers/types";

/** The answer of public.job_message_may_send: never an address or a name. */
export type MaySendAnswer = { may_send: true } | { may_send: false; reason: string };

export type MaySendCall = (job: { id: string; lease: string }) => Promise<unknown>;

function parseAnswer(data: unknown): MaySendAnswer | null {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (r.may_send === true) return { may_send: true };
  if (r.may_send === false && typeof r.reason === "string") return { may_send: false, reason: r.reason };
  return null;
}

function target(job: ClaimedJob) {
  const channel = job.payload.channel;
  const lead = job.payload.lead_id;
  const contact = job.payload.contact_id;
  if (!isMessageChannel(channel)) return null;
  if (typeof lead === "string" && contact === undefined) return { channel, recordType: "lead" as const, recordId: lead };
  if (typeof contact === "string" && lead === undefined) return { channel, recordType: "contact" as const, recordId: contact };
  return null;
}

/**
 * The message.send handler (OPS-04). Before every send it asks the database ONE question, public.job_message_may_send,
 * which checks the business's pause (HEB-09, app.customer_sending_paused) and the address's consent
 * (app.consent_suppressed; cannot check = no), a business that cannot write, an event time that passed, a gone record
 * and a missing address. On "no" the database has already ended the job as refused with its reason, or, during a pause
 * of under 24 hours (owner (52) ג, answer `retry: true`), queued it again uncounted; either way nothing is sent now. A
 * malformed answer is a failed try, never a send.
 * MSG-01: the provider is the job's channel's (providerFor, select.ts). The worker claims only jobs of channels that
 * have a provider (claim_jobs' p_channels), so a job of an unconfigured channel waits in the queue, unclaimed and
 * uncounted. The no-provider branch below is only a safety net (a job claimed some other way): a failed try before the
 * database is asked (nothing is checked or recorded), never a send through another channel's provider.
 */
export function createSendHandler(deps: {
  maySend: MaySendCall;
  providerFor: (channel: MessageChannel) => MessagingProvider | null | undefined;
}): JobHandler {
  return async (job) => {
    const to = target(job);
    if (!to) return { status: "failed", error: "payload", final: true };
    const provider = deps.providerFor(to.channel);
    if (!provider || provider.channel !== to.channel) return { status: "failed", error: "no provider for channel" };
    const answer = parseAnswer(await deps.maySend(job));
    if (!answer) return { status: "failed", error: "send check answered nothing" };
    if (!answer.may_send) return { status: "ended", reason: answer.reason };
    const result = await provider.send({ jobId: job.id, organizationId: job.organization_id, ...to });
    if (result.ok) return { status: "done" };
    return { status: "failed", error: result.error, final: result.final };
  };
}
