import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";

import type { MessageChannel, MessagingProvider } from "./providers/types";

/** The answer of public.job_message_may_send: never an address or a name. */
export type MaySendAnswer = { may_send: true } | { may_send: false; reason: string };

export type MaySendCall = (job: { id: string; lease: string }) => Promise<unknown>;

const CHANNELS: readonly MessageChannel[] = ["email", "sms", "whatsapp"];

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
  if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) return null;
  if (typeof lead === "string" && contact === undefined) return { channel: channel as MessageChannel, recordType: "lead" as const, recordId: lead };
  if (typeof contact === "string" && lead === undefined) return { channel: channel as MessageChannel, recordType: "contact" as const, recordId: contact };
  return null;
}

/**
 * The message.send handler (OPS-04). Before every send it asks the database ONE question, public.job_message_may_send,
 * which checks the business's pause (HEB-09, app.customer_sending_paused) and the address's consent
 * (app.consent_suppressed; cannot check = no), a closed business, a gone record and a missing address. On "no" the
 * database has already ended the job as refused with its reason, and nothing is sent. A malformed answer is a failed try,
 * never a send.
 */
export function createSendHandler(deps: { maySend: MaySendCall; provider: MessagingProvider }): JobHandler {
  return async (job) => {
    const to = target(job);
    if (!to) return { status: "failed", error: "payload", final: true };
    const answer = parseAnswer(await deps.maySend(job));
    if (!answer) return { status: "failed", error: "send check answered nothing" };
    if (!answer.may_send) return { status: "ended", reason: answer.reason };
    const result = await deps.provider.send({ jobId: job.id, organizationId: job.organization_id, ...to });
    if (result.ok) return { status: "done" };
    return { status: "failed", error: result.error, final: result.final };
  };
}
