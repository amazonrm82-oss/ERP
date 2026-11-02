// OPS-04: the kinds of background job and their handlers. JOB_KINDS mirrors app.job_kinds() (migration _jobs_queue.sql;
// tests/unit/jobs-queue.test.ts reads it). A kind runs only when a handler for it is registered, so a job whose handler is
// not ready (no provider yet) stays queued instead of failing.

export const JOB_KINDS = ["message.send"] as const;
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
 * What a handler reports:
 * - done: the work is done;
 * - failed: try again later (backoff), or never again when `final`;
 * - ended: the database already ended the job itself (a refused send); nothing more to report.
 */
export type JobOutcome =
  | { status: "done" }
  | { status: "failed"; error: string; final?: boolean }
  | { status: "ended"; reason: string };

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
