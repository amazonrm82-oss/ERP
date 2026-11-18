// OPS-04: the kinds of background job and their handlers. JOB_KINDS mirrors app.job_kinds() (migration _jobs_queue.sql;
// tests/unit/jobs-queue.test.ts reads it). A kind runs only when a handler for it is registered, so a job whose handler is
// not ready (no provider yet) stays queued instead of failing.

// IMP-04 (owner (155) א): import.run and export.run, the background import and full export of src/features/background/
// USR-11 / WAB-03 (owner (267) א, (375) ב): digest.send, the daily summary email, registered while the email channel has a
// provider (src/features/digest/send-handler.ts); until a worker asks for it app.queue_daily_digests queues nothing.
// RPT-03 (owner (386) א): report.send, a scheduled report email with a link only (src/features/report-schedules/send-handler.ts),
// registered beside digest.send while the email channel has a provider.
// USR-09 (owner (387) א): invite.send, a staff invitation email (src/features/invitations/send-handler.ts), in the same pass.
// DOC-07 (owner (398) א): invoice.issue, a document through the invoice provider (src/features/invoicing/issue-handler.ts),
// registered while this deployment offers a provider.
// LNK-02 (owner (394) א): payment_link.create, the provider's hosted page of a payment link
// (src/features/payment-links/page-handler.ts), registered while this deployment offers a payment provider; LNK-07:
// payment_link.refund, a refund of a link's payment through it (src/features/payment-links/refund-handler.ts).
export const JOB_KINDS = ["message.send", "import.run", "export.run", "digest.send", "report.send", "invite.send", "invoice.issue", "payment_link.create", "payment_link.refund"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

/** A job as public.claim_jobs answers it: ids and codes only. */
export type ClaimedJob = {
  id: string;
  lease: string;
  kind: JobKind;
  organization_id: string;
  payload: Record<string, unknown>;
  attempt: number;
};

/**
 * MSG-03: what the provider answered, kept on the job by finish_job (codes and ids only): its code with its message id
 * (sent) or its short error code (failed).
 */
export type ProviderReceipt = { provider: string | null; providerMessageId?: string; errorCode?: string };
// SMS-05: provider null = the composer refused before any provider was asked (errorCode = its code)

/**
 * What a handler reports:
 * - done: the work is done (a sent message carries the provider's receipt);
 * - failed: try again later (backoff), or never again when `final`;
 * - ended: the database already ended the job itself (a refused send); nothing more to report.
 */
export type JobOutcome =
  | { status: "done"; receipt?: ProviderReceipt }
  | { status: "failed"; error: string; final?: boolean; receipt?: ProviderReceipt }
  | { status: "ended"; reason: string }
  // IMP-04: a long job saved its progress and stops at its time budget; it goes back to the queue uncounted
  | { status: "yield" };

export type JobHandler = (job: ClaimedJob) => Promise<JobOutcome>;

export type JobRegistry = {
  kinds: JobKind[];
  handlerFor(kind: string): JobHandler | null;
};

export function createRegistry(handlers: Partial<Record<JobKind, JobHandler | null>>): JobRegistry {
  const ready = new Map<JobKind, JobHandler>();
  for (const kind of JOB_KINDS) {
    const handler = handlers[kind];
    if (handler) ready.set(kind, handler);
  }
  return {
    kinds: [...ready.keys()],
    handlerFor: (kind) => (isJobKind(kind) ? (ready.get(kind) ?? null) : null),
  };
}

/** Parses claim_jobs' answer; anything malformed is left out (and stays claimed until its lease runs out). */
export function parseClaimed(data: unknown): ClaimedJob[] {
  if (!Array.isArray(data)) return [];
  const out: ClaimedJob[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.lease !== "string" || typeof r.organization_id !== "string") continue;
    if (!isJobKind(r.kind) || !r.payload || typeof r.payload !== "object" || Array.isArray(r.payload)) continue;
    out.push({
      id: r.id,
      lease: r.lease,
      kind: r.kind,
      organization_id: r.organization_id,
      payload: r.payload as Record<string, unknown>,
      attempt: typeof r.attempt === "number" ? r.attempt : 0,
    });
  }
  return out;
}

/** An error kept on a job: no email address, no run of digits, at most 300 characters (the database redacts again). */
export function redactJobError(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "error";
  const clean = text
    .replace(/[^\s<>"',;:]+@[^\s<>"',;:]+/g, "[email]")
    .replace(/[+]?[0-9][0-9 ()-]{4,}[0-9]/g, "[number]")
    .trim()
    .slice(0, 300);
  return clean === "" ? "error" : clean;
}
