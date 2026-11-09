import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildFullExport } from "@/features/imports/export";
import { CHUNK_SIZE } from "@/features/imports/fields";
import { finishImportCore, importChunkCore, startImportCore, type ImportSession } from "@/features/imports/run-core";
import type { ClaimedJob, JobHandler, JobOutcome } from "@/features/jobs/registry";
import type { Database } from "@/lib/database.types";

import {
  addOutcomes,
  BACKGROUND_IMPORT_MODES,
  BACKGROUND_MODE_ONLY,
  BACKGROUND_RUN_BUDGET_MS,
  backgroundSourceSchema,
  EXPORT_TOO_LARGE,
  exportPath,
  JOB_FILES_BUCKET,
  parseBegun,
  uploadTooLarge,
  type BackgroundSource,
  type Begun,
  type ImportCounts,
} from "./rules";
import { TokenRefused, type BackgroundTokenSource } from "./user-token";

/**
 * The worker's calls for a background job (service_role, live lease only). run-server.ts makes them; this file never
 * holds the service key, and never sees claims: the token source (user-token.ts) asks public.background_job_token itself
 * before every signing.
 */
export type BackgroundCalls = {
  begin(job: ClaimedJob): Promise<unknown>;
  progress(job: ClaimedJob, importJobId: string | null, rowsDone: number, counts: ImportCounts): Promise<string | null>;
  end(job: ClaimedJob, ok: boolean, counts: Record<string, number> | null, message: string | null, filePath: string | null): Promise<string | null>;
};

export type BackgroundDeps = {
  calls: BackgroundCalls;
  /** The person's token source for this job and lease (createBackgroundTokenSource in run-server.ts). */
  tokenSource(job: ClaimedJob): BackgroundTokenSource;
  /** A client that acts as the person through that source (null = not set up). */
  userClient(source: BackgroundTokenSource): SupabaseClient<Database> | null;
  now?: () => number;
  budgetMs?: number;
};

const NOT_READ = "לא הצלחנו לקרוא את הקובץ שהועלה. אפשר לייבא אותו שוב.";
const EXPORT_FAILED = "לא הצלחנו להכין את הקובץ. אפשר לנסות שוב, או להוריד את הייצוא ישירות מעמוד הייבוא והייצוא.";

type Started = { begun: Extract<Begun, { ok: true }>; client: SupabaseClient<Database>; session: ImportSession; refused: () => string | null };

async function begin(deps: BackgroundDeps, job: ClaimedJob, kind: "import" | "export"): Promise<Started | JobOutcome> {
  const begun = parseBegun(await deps.calls.begin(job));
  // a refusal already ended the job (and the order, with a notice) in the database
  if (!begun.ok) return { status: "ended", reason: begun.reason };
  if (begun.kind !== kind) return { status: "failed", error: "kind mismatch", final: true };
  const userId = typeof job.payload.user_id === "string" ? job.payload.user_id : null;
  if (!userId) return { status: "failed", error: "no person", final: true };
  const source = deps.tokenSource(job);
  // the first signing, before anything is read or written: the database checks the person now
  try {
    await source.token();
  } catch (error) {
    if (error instanceof TokenRefused) return { status: "ended", reason: error.reason };
    throw error;
  }
  const client = deps.userClient(source);
  if (!client) return { status: "failed", error: "not configured" };
  return { begun, client, session: { supabase: client, userId }, refused: source.refused };
}

/**
 * A refresh the database refused (TokenRefused, raised from inside a client call) already ended the job and the order
 * there: the handler stops at once and reports nothing more.
 */
function stopOnRefusal(handler: JobHandler): JobHandler {
  return async (job) => {
    try {
      return await handler(job);
    } catch (error) {
      if (error instanceof TokenRefused) return { status: "ended", reason: error.reason };
      throw error;
    }
  };
}

/** import.run: the uploaded rows, chunk by chunk, through the browser path's own code, as the person. */
export function createImportHandler(deps: BackgroundDeps): JobHandler {
  return stopOnRefusal(async (job) => {
    const now = deps.now ?? Date.now;
    const deadline = now() + (deps.budgetMs ?? BACKGROUND_RUN_BUDGET_MS);
    const started = await begin(deps, job, "import");
    if ("status" in started) return started;
    const { begun, client, session, refused } = started;
    const orgId = job.organization_id;
    let counts = begun.counts;

    // a refused refresh already ended the job and the order in the database: nothing more to report
    const stoppedByCheck = (): JobOutcome | null => {
      const reason = refused();
      return reason ? { status: "ended", reason } : null;
    };
    const end = async (ok: boolean, message: string | null): Promise<JobOutcome> => {
      const check = stoppedByCheck();
      if (check) return check;
      const answer = await deps.calls.end(job, ok, counts, message, null);
      if (answer === "ended" || answer === "cancelled") return { status: "done" };
      return { status: "failed", error: `end ${answer ?? "error"}` };
    };

    // the file the person uploaded, read with the person's own token (the bucket's policy decides)
    if (!begun.sourcePath) return end(false, NOT_READ);
    const download = await client.storage.from(JOB_FILES_BUCKET).download(begun.sourcePath);
    if (download.error || !download.data) return end(false, NOT_READ);
    let source: BackgroundSource;
    try {
      const parsed = backgroundSourceSchema.safeParse(JSON.parse(await download.data.text()));
      if (!parsed.success) return end(false, NOT_READ);
      source = parsed.data;
    } catch {
      return end(false, NOT_READ);
    }
    // owner (163) ב: only "skip" or "update", and only the rule the order was made with
    if (!(BACKGROUND_IMPORT_MODES as readonly string[]).includes(source.mode) || source.mode !== begun.duplicateMode) {
      return end(false, BACKGROUND_MODE_ONLY);
    }

    let jobId = begun.importJobId;
    if (!jobId) {
      const made = await startImportCore(session, orgId, {
        entity: source.entity,
        mode: source.mode,
        fileName: source.fileName,
        totalRows: source.rows.length,
        mapsCompany: source.mapsCompany,
        consent: source.consent ?? null,
      });
      if (!made.ok) return end(false, made.message);
      jobId = made.data?.jobId ?? null;
      if (!jobId) return end(false, NOT_READ);
      const saved = await deps.calls.progress(job, jobId, begun.rowsDone, counts);
      if (saved === "cancelled") {
        await finishImportCore(session, orgId, jobId, { ...counts, stopped: true });
        return { status: "done" };
      }
      if (saved !== "ok") return stoppedByCheck() ?? { status: "failed", error: `progress ${saved ?? "error"}` };
    }

    for (let at = begun.rowsDone; at < source.rows.length; at += CHUNK_SIZE) {
      // the place is saved after every chunk: hand the job back and go on in the next run
      if (now() >= deadline) return { status: "yield" };
      const rows = source.rows.slice(at, at + CHUNK_SIZE);
      const result = await importChunkCore(session, orgId, jobId, { mapping: source.mapping, rows, firstRow: at + 1 });
      const check = stoppedByCheck();
      if (check) return check;
      if (!result.ok) {
        await finishImportCore(session, orgId, jobId, { ...counts, stopped: true });
        return end(false, result.message);
      }
      counts = addOutcomes(counts, result.data?.outcomes ?? []);
      if (result.data?.stopped) {
        await finishImportCore(session, orgId, jobId, { ...counts, stopped: true });
        return end(false, result.data.stopped);
      }
      const saved = await deps.calls.progress(job, jobId, at + rows.length, counts);
      if (saved === "cancelled") {
        await finishImportCore(session, orgId, jobId, { ...counts, stopped: true });
        return { status: "done" };
      }
      if (saved !== "ok") return stoppedByCheck() ?? { status: "failed", error: `progress ${saved ?? "error"}` };
    }

    const finished = await finishImportCore(session, orgId, jobId, { ...counts, stopped: false });
    if (!finished.ok) return end(false, finished.message);
    return end(true, null);
  });
}

/** export.run: the full export, read with the person's token; logged (log_export) before the file is kept. */
export function createExportHandler(deps: BackgroundDeps): JobHandler {
  return stopOnRefusal(async (job) => {
    const started = await begin(deps, job, "export");
    if ("status" in started) return started;
    const { begun, client, refused } = started;
    const orgId = job.organization_id;

    const end = async (ok: boolean, rows: number | null, message: string | null, path: string | null): Promise<JobOutcome> => {
      const reason = refused();
      if (reason) return { status: "ended", reason };
      const answer = await deps.calls.end(job, ok, rows === null ? null : { rows }, message, path);
      if (answer === "ended" || answer === "cancelled") return { status: "done" };
      return { status: "failed", error: `end ${answer ?? "error"}` };
    };

    let built: { zip: Uint8Array; rows: number };
    try {
      built = await buildFullExport(orgId, client);
    } catch {
      return end(false, null, EXPORT_FAILED, null);
    }
    // IMP-02: written to the audit log before the file is kept; no log, no file (as the download route)
    const { error: logError } = await client.rpc("log_export", { p_org: orgId, p_kind: "full", p_report: null, p_rows: built.rows });
    if (logError) return end(false, built.rows, EXPORT_FAILED, null);
    const path = exportPath(orgId, begun.requestId, randomUUID());
    const { error: uploadError } = await client.storage
      .from(JOB_FILES_BUCKET)
      .upload(path, built.zip, { contentType: "application/zip", upsert: false });
    if (uploadError) {
      // owner (162) ב: over the upload limit the order ends with a notice that points to the direct download; any other
      // failure is tried again (the queue's backoff; after the last try the sweep ends it with a notice)
      if (uploadTooLarge(uploadError)) return end(false, built.rows, EXPORT_TOO_LARGE, null);
      return { status: "failed", error: "upload failed" };
    }
    return end(true, built.rows, null, path);
  });
}
