import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";

import {
  isMessageChannel,
  isMessageType,
  messagePurpose,
  type MessageChannel,
  type MessagingProvider,
  type RecordEmailParts,
  type SmsParts,
} from "./providers/types";

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

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * EML-02: the ids of an email sent from a record's card (app.job_payload_ok holds their shape); undefined when the job
 * carries none of them, so every other message is handed over exactly as before.
 */
export function recordEmailParts(payload: Record<string, unknown>): RecordEmailParts | undefined {
  const { template_id: template, deal_id: deal, file_ids: files, library_file_ids: library, reply_to_user_id: replyTo } = payload;
  if (deal === undefined && files === undefined && library === undefined && replyTo === undefined) return undefined;
  return {
    templateId: isId(template) ? template : null,
    dealId: isId(deal) ? deal : null,
    fileIds: Array.isArray(files) ? files.filter(isId) : [],
    libraryFileIds: Array.isArray(library) ? library.filter(isId) : [],
    replyToUserId: isId(replyTo) ? replyTo : null,
  };
}

/**
 * SMS-02: the ids of an SMS sent from a record's card or queued by an automation (app.job_payload_ok holds their shape);
 * undefined when the job carries none of them, so every other message is handed over exactly as before.
 */
export function smsMessageParts(payload: Record<string, unknown>): SmsParts | undefined {
  const { template_id: template, deal_id: deal, sent_by_user_id: sentBy, automation_id: automation } = payload;
  if (sentBy === undefined && automation === undefined && deal === undefined) return undefined;
  return {
    templateId: isId(template) ? template : null,
    dealId: isId(deal) ? deal : null,
    sentByUserId: isId(sentBy) ? sentBy : null,
    automationId: isId(automation) ? automation : null,
  };
}

function target(job: ClaimedJob) {
  const channel = job.payload.channel;
  const lead = job.payload.lead_id;
  const contact = job.payload.contact_id;
  const given = job.payload.message_type;
  if (!isMessageChannel(channel)) return null;
  // CNS-07: a job queued before types existed has none and counts as marketing, as in the database's send check
  if (given !== undefined && !isMessageType(given)) return null;
  const messageType = given ?? null;
  const email = channel === "email" ? recordEmailParts(job.payload) : undefined;
  const sms = channel === "sms" ? smsMessageParts(job.payload) : undefined;
  const kind = { channel, messageType, purpose: messagePurpose(messageType), ...(email ? { email } : {}), ...(sms ? { sms } : {}) };
  // SMS-01b: a sender-number check's code (sms, verification_code, nothing a record carries; app.job_payload_ok)
  const check = job.payload.sender_check_id;
  if (typeof check === "string" && lead === undefined && contact === undefined) {
    if (channel !== "sms" || messageType !== "verification_code") return null;
    return { ...kind, recordType: "sender_check" as const, recordId: check };
  }
  if (typeof lead === "string" && contact === undefined) return { ...kind, recordType: "lead" as const, recordId: lead };
  if (typeof contact === "string" && lead === undefined) return { ...kind, recordType: "contact" as const, recordId: contact };
  return null;
}

/**
 * The message.send handler (OPS-04). Before every send it asks the database ONE question, public.job_message_may_send,
 * which checks the business's pause (HEB-09, app.customer_sending_paused) and the address's consent
 * (CNS-07: a marketing message needs a recorded grant and no opt-out; a service message type is refused only on the
 * blocklist or an erasure block; cannot check = no), a business that cannot write, an event time that passed, a gone record
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
    // MSG-03: the provider's code with its message id (sent) or its error code (failed) go back to the queue, which
    // records the message; the database drops a value of the wrong shape
    if (result.ok) return { status: "done", receipt: { provider: provider.name, providerMessageId: result.providerId } };
    return {
      status: "failed",
      error: result.error,
      final: result.final,
      receipt: { provider: provider.name, ...(typeof result.code === "string" ? { errorCode: result.code } : {}) },
    };
  };
}
