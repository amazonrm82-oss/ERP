import { z } from "zod";

// IMP-04 (owner (155) א, 9 November 2026): background imports and the full export, through the OPS-04 queue.
// Pure rules shared by the browser, the actions and the worker.

/** The private bucket of the uploaded rows and the export's file (migration _background_jobs.sql). */
export const JOB_FILES_BUCKET = "job-files";

/** Files are kept this long, then the nightly cleanup removes them (app.background_requests_sweep). */
export const BACKGROUND_FILE_DAYS = 7;

/** Above this many rows the wizard offers the background path (the browser path stays for every size). */
export const BACKGROUND_IMPORT_MIN_ROWS = 2_000;

/** At most this many open orders per person and business (trigger background_requests_new, hint background:busy). */
export const BACKGROUND_OPEN_MAX = 3;

/** The worker's time per run for one background job, before it saves its place and hands the job back. */
export const BACKGROUND_RUN_BUDGET_MS = 40_000;

/** The worker's token of the ordering person lives this long (it is made again for every run). */
export const USER_TOKEN_SECONDS = 600;

export const BACKGROUND_STATUS_LABEL: Record<string, string> = {
  awaiting_file: "ממתין לקובץ",
  queued: "ממתין בתור",
  running: "רץ ברקע",
  done: "הסתיים",
  failed: "נעצר",
  cancelled: "בוטל",
};

export const BACKGROUND_BUSY = "יש לכם כבר שלוש עבודות ברקע שעוד לא הסתיימו. אפשר להזמין עוד אחת כשאחת מהן תסתיים.";
export const BACKGROUND_NO_FILE = "הקובץ לא הגיע לשרת. נסו שוב.";
export const BACKGROUND_STATE = "העבודה הזו כבר לא ממתינה לקובץ.";

/** The path of the uploaded rows (the trigger background_requests_new keeps the same). */
export function sourcePath(orgId: string, requestId: string): string {
  return `${orgId}/${requestId}/source.json`;
}

/** The export's file: in the order's own folder, a fresh name per attempt (the bucket never overwrites). */
export function exportPath(orgId: string, requestId: string, fileId: string): string {
  return `${orgId}/${requestId}/${fileId}.zip`;
}

/**
 * The uploaded rows of a background import: exactly what the browser would send the Server Actions chunk by chunk,
 * judged again by the same code when the worker runs them (src/features/imports/run-core.ts).
 */
export const backgroundSourceSchema = z.object({
  version: z.literal(1),
  entity: z.string().max(20),
  mode: z.string().max(20),
  fileName: z.string().max(2000),
  mapsCompany: z.boolean().optional(),
  consent: z.object({ method: z.string().max(40), note: z.string().max(2000) }).nullable().optional(),
  mapping: z.array(z.string().max(100)).max(200),
  rows: z.array(z.array(z.string().max(10_000)).max(200)).min(1).max(50_000),
});
export type BackgroundSource = z.infer<typeof backgroundSourceSchema>;

export type ImportCounts = { created: number; updated: number; skipped: number; failed: number };

/** Adds a chunk's outcomes to the running counts (the wizard counts the same way). */
export function addOutcomes(counts: ImportCounts, outcomes: ReadonlyArray<{ status: string }>): ImportCounts {
  const next = { ...counts };
  for (const o of outcomes) {
    if (o.status === "created") next.created += 1;
    else if (o.status === "updated") next.updated += 1;
    else if (o.status === "skipped") next.skipped += 1;
    else if (o.status === "failed") next.failed += 1;
  }
  return next;
}

/** The counts kept on the order, read back (anything missing or malformed is 0). */
export function readCounts(value: unknown): ImportCounts {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0);
  return { created: n(v.created), updated: n(v.updated), skipped: n(v.skipped), failed: n(v.failed) };
}

/** What public.background_job_begin answers (never the claims: those come only from background_job_token). */
export type Begun =
  | {
      ok: true;
      kind: "import" | "export";
      requestId: string;
      // owner (163) ב: a background import only skips or updates duplicates
      duplicateMode: "skip" | "update" | null;
      importJobId: string | null;
      rowsDone: number;
      counts: ImportCounts;
      sourcePath: string | null;
    }
  | { ok: false; reason: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses begin's answer; anything malformed is "not ok" (nothing runs). */
export function parseBegun(data: unknown): Begun {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "malformed" };
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return { ok: false, reason: typeof d.reason === "string" ? d.reason : "malformed" };
  if ((d.kind !== "import" && d.kind !== "export") || typeof d.request_id !== "string" || !uuid.test(d.request_id)) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    kind: d.kind,
    requestId: d.request_id,
    duplicateMode: d.duplicate_mode === "skip" || d.duplicate_mode === "update" ? d.duplicate_mode : null,
    importJobId: typeof d.import_job_id === "string" && uuid.test(d.import_job_id) ? d.import_job_id : null,
    rowsDone: typeof d.rows_done === "number" && Number.isInteger(d.rows_done) && d.rows_done >= 0 ? d.rows_done : 0,
    counts: readCounts(d.counts),
    sourcePath: typeof d.source_path === "string" ? d.source_path : null,
  };
}

/** Exactly what the person's token carries. */
export type TokenClaims = { sub: string; role: "authenticated"; aal: "aal1" | "aal2"; session_id: string; crm_background: string };

/** What public.background_job_token answered, or the refusal; anything else is a refusal ("malformed"). */
export type TokenAnswer = { ok: true; claims: TokenClaims; lockedUntilSeconds: number } | { ok: false; reason: string };

/**
 * Only an authenticated person with a session and this order, and the lease's end; nothing else of the answer reaches
 * the token.
 */
export function parseTokenAnswer(data: unknown, requestId: string): TokenAnswer {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "malformed" };
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return { ok: false, reason: typeof d.reason === "string" ? d.reason : "malformed" };
  const c = d.claims as Record<string, unknown> | null;
  const lockedUntil = typeof d.locked_until === "string" ? Date.parse(d.locked_until) : Number.NaN;
  if (
    !c ||
    typeof c !== "object" ||
    typeof c.sub !== "string" ||
    !uuid.test(c.sub) ||
    c.role !== "authenticated" ||
    (c.aal !== "aal1" && c.aal !== "aal2") ||
    typeof c.session_id !== "string" ||
    !uuid.test(c.session_id) ||
    c.crm_background !== requestId ||
    !Number.isFinite(lockedUntil)
  ) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    claims: { sub: c.sub, role: "authenticated", aal: c.aal, session_id: c.session_id, crm_background: c.crm_background },
    lockedUntilSeconds: Math.floor(lockedUntil / 1000),
  };
}

/** owner (162) ב: the storage refused the export for its size (the project's upload limit). */
export function uploadTooLarge(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 413 || e.statusCode === "413" || e.statusCode === 413) return true;
  return typeof e.message === "string" && /too large|exceed|maximum allowed size|payload/i.test(e.message);
}

/** owner (162) ב: what the person is told when the export is too large to keep: the direct download. */
export const EXPORT_TOO_LARGE =
  "הייצוא גדול מהגודל שאפשר לשמור ברקע. אפשר להוריד אותו ישירות מעמוד הייבוא והייצוא, בכפתור \"הורדת ייצוא מלא\".";

/** owner (163) ב: the duplicate rules a background import may run with. */
export const BACKGROUND_IMPORT_MODES = ["skip", "update"] as const;
export const BACKGROUND_MODE_ONLY = "ייבוא ברקע אפשרי רק כשרשומות כפולות מדולגות או מעודכנות, לא כשנוצרות שוב.";
