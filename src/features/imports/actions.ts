"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { CHUNK_SIZE, CUSTOM_PREFIX, IMPORT_TARGETS, MAX_IMPORT_ROWS, type DuplicateModeKey, type ImportEntityKey } from "./fields";
import { ImportStopped, loadLookups, processChunk, type ImportContext, type RowOutcome } from "./server";

const entitySchema = z.enum(["lead", "contact", "company"]);
const modeSchema = z.enum(["skip", "update", "create"]);
const cellsSchema = z.array(z.array(z.string().max(10_000)).max(200)).max(CHUNK_SIZE);
const mappingSchema = z.array(z.string().max(100)).max(200);

const TABLE = { lead: "leads", contact: "contacts", company: "companies" } as const;
const UNDO_DAYS = 7;

async function importContext(orgId: string, entity: ImportEntityKey, mode: DuplicateModeKey, mapping: string[]) {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const definitions = await listFieldDefinitions(orgId, entity);
  const allowed = new Set([...IMPORT_TARGETS[entity].map((t) => t.key), ...definitions.map((d) => `${CUSTOM_PREFIX}${d.key}`), ""]);
  if (!mapping.every((target) => allowed.has(target))) {
    return fail("המיפוי אינו תקין. נסו לבחור שוב את השדות.");
  }
  if (!mapping.some(Boolean)) {
    return fail("יש לבחור לפחות עמודה אחת לייבוא.");
  }
  const ctx: ImportContext = { supabase: context.supabase, orgId, userId: context.user.id, entity, mode, mapping, definitions };
  return { ok: true as const, ctx };
}

/** Checks the first rows without writing anything. */
export async function previewImportAction(
  orgId: string,
  input: { entity: string; mode: string; mapping: string[]; rows: string[][] },
): Promise<ActionResult<RowOutcome[]>> {
  const entity = entitySchema.safeParse(input.entity);
  const mode = modeSchema.safeParse(input.mode);
  const mapping = mappingSchema.safeParse(input.mapping);
  const rows = cellsSchema.safeParse(input.rows);
  if (!entity.success || !mode.success || !mapping.success || !rows.success) {
    return fail("הקובץ או המיפוי אינם תקינים.");
  }
  const prepared = await importContext(orgId, entity.data, mode.data, mapping.data);
  if (!prepared.ok) return prepared;
  return ok(await processChunk(prepared.ctx, null, rows.data, 1, null));
}

/** Creates the import job; the browser then sends the rows chunk by chunk. */
export async function startImportAction(
  orgId: string,
  input: { entity: string; mode: string; fileName: string; totalRows: number },
): Promise<ActionResult<{ jobId: string }>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const entity = entitySchema.safeParse(input.entity);
  const mode = modeSchema.safeParse(input.mode);
  if (!entity.success || !mode.success || !Number.isInteger(input.totalRows) || input.totalRows < 1 || input.totalRows > MAX_IMPORT_ROWS) {
    return fail("הקובץ אינו תקין.");
  }
  const { data, error } = await context.supabase
    .from("import_jobs")
    .insert({
      organization_id: orgId,
      entity_type: entity.data,
      duplicate_mode: mode.data,
      file_name: (input.fileName || "file").slice(0, 255),
      total_rows: input.totalRows,
    })
    .select("id")
    .single();
  if (error) {
    return fail(error.code === "42501" ? "ייבוא מותר לבעלים, למנהלי מערכת ולמנהלי צוות." : dbErrorMessage(error, "לא הצלחנו להתחיל את הייבוא."));
  }
  return ok({ jobId: data.id });
}

/** Writes one chunk of rows into a running job of the user. */
export async function importChunkAction(
  orgId: string,
  jobId: string,
  input: { mapping: string[]; rows: string[][]; firstRow: number },
): Promise<ActionResult<{ outcomes: RowOutcome[]; stopped: string | null }>> {
  const context = await actionContext(orgId, jobId);
  if (!context.ok) return context;
  const mapping = mappingSchema.safeParse(input.mapping);
  const rows = cellsSchema.safeParse(input.rows);
  if (!mapping.success || !rows.success || !Number.isInteger(input.firstRow) || input.firstRow < 1) {
    return fail("הנתונים שנשלחו אינם תקינים.");
  }
  // the job decides the object and the duplicate rule, not the browser
  const { data: job, error: jobError } = await context.supabase
    .from("import_jobs")
    .select("entity_type, duplicate_mode, status, created_by")
    .eq("organization_id", orgId)
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) return fail(dbErrorMessage(jobError));
  if (!job || job.created_by !== context.user.id) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  // marks the job as alive (updated_at); a job idle for 10 minutes is closed by the database (FXC-03)
  const { data: alive, error: aliveError } = await context.supabase
    .from("import_jobs")
    .update({ status: "running" })
    .eq("organization_id", orgId)
    .eq("id", jobId)
    .eq("status", "running")
    .select("id");
  if (aliveError) return fail(dbErrorMessage(aliveError, "לא הצלחנו להמשיך את הייבוא."));
  if (alive.length === 0) {
    return fail("הייבוא נעצר כי לא התקבלו נתונים כמה דקות. אפשר לבטל אותו בהיסטוריית הייבוא ולייבא שוב.");
  }
  const entity = entitySchema.parse(job.entity_type);
  const prepared = await importContext(orgId, entity, modeSchema.parse(job.duplicate_mode), mapping.data);
  if (!prepared.ok) return prepared;
  try {
    const lookups = await loadLookups(prepared.ctx);
    return ok({ outcomes: await processChunk(prepared.ctx, lookups, rows.data, input.firstRow, jobId), stopped: null });
  } catch (error) {
    if (error instanceof ImportStopped) {
      return ok({ outcomes: [], stopped: error.message });
    }
    throw error;
  }
}

/** Closes the job with its counts. created_count is counted in the database. */
export async function finishImportAction(
  orgId: string,
  jobId: string,
  input: { updated: number; skipped: number; failed: number; stopped: boolean },
): Promise<ActionResult> {
  const context = await actionContext(orgId, jobId);
  if (!context.ok) return context;
  const { data: job, error: jobError } = await context.supabase.from("import_jobs").select("entity_type").eq("organization_id", orgId).eq("id", jobId).maybeSingle();
  if (jobError) return fail(dbErrorMessage(jobError));
  if (!job) return fail(NOT_FOUND_OR_FORBIDDEN);
  const entity = entitySchema.parse(job.entity_type);
  const { count } = await context.supabase
    .from(TABLE[entity])
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("import_job_id", jobId);
  const clamp = (n: number) => (Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_IMPORT_ROWS) : 0);
  const { data, error } = await context.supabase
    .from("import_jobs")
    .update({
      status: input.stopped ? "failed" : "done",
      created_count: count ?? 0,
      updated_count: clamp(input.updated),
      skipped_count: clamp(input.skipped),
      failed_count: clamp(input.failed),
      finished_at: new Date().toISOString(),
    })
    .eq("organization_id", orgId)
    .eq("id", jobId)
    .eq("status", "running")
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לסגור את הייבוא."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.imports(orgId));
  return ok();
}

/**
 * The companies a contacts import created go to the recycle bin with its contacts,
 * except one that a contact from outside the import uses by now.
 */
async function trashImportedCompanies(supabase: ImportContext["supabase"], orgId: string, jobId: string): Promise<string | null> {
  const { data: companies, error } = await supabase.from("companies").select("id").eq("organization_id", orgId).eq("import_job_id", jobId).is("deleted_at", null);
  if (error) return dbErrorMessage(error, "אנשי הקשר הועברו לסל המחזור, אבל לא הצלחנו לבדוק את החברות שנוצרו בייבוא.");
  if (companies.length === 0) return null;
  const ids = companies.map((c) => c.id);
  const inUse = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: users, error: usersError } = await supabase
      .from("contacts")
      .select("company_id, import_job_id")
      .eq("organization_id", orgId)
      .in("company_id", ids.slice(i, i + 200))
      .is("deleted_at", null);
    if (usersError) return dbErrorMessage(usersError, "אנשי הקשר הועברו לסל המחזור, אבל לא הצלחנו לבדוק את החברות שנוצרו בייבוא.");
    for (const u of users) if (u.company_id && u.import_job_id !== jobId) inUse.add(u.company_id);
  }
  const unused = ids.filter((id) => !inUse.has(id));
  for (let i = 0; i < unused.length; i += 200) {
    const { error: trashError } = await supabase
      .from("companies")
      .update({ deleted_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .in("id", unused.slice(i, i + 200))
      .is("deleted_at", null);
    if (trashError) return dbErrorMessage(trashError, "אנשי הקשר הועברו לסל המחזור, אבל לא הצלחנו להעביר את החברות שנוצרו בייבוא.");
  }
  return null;
}

/** Moves the records an import created to the recycle bin (within 7 days). Updates are not reverted. */
export async function undoImportAction(orgId: string, jobId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, jobId);
  if (!context.ok) return context;
  const { data: job, error: jobReadError } = await context.supabase
    .from("import_jobs")
    .select("entity_type, status, created_by, created_at")
    .eq("organization_id", orgId)
    .eq("id", jobId)
    .maybeSingle();
  if (jobReadError) return fail(dbErrorMessage(jobReadError));
  if (!job || job.created_by !== context.user.id) return fail("רק מי שייבא את הקובץ יכול לבטל את הייבוא.");
  if (job.status === "undone") return fail("הייבוא כבר בוטל.");
  if (job.status === "running") return fail("הייבוא עדיין רץ.");
  if (Date.now() - Date.parse(job.created_at) > UNDO_DAYS * 86_400_000) return fail("אפשר לבטל ייבוא רק בשבעת הימים הראשונים.");

  const entity = entitySchema.parse(job.entity_type);
  const { error } = await context.supabase
    .from(TABLE[entity])
    .update({ deleted_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("import_job_id", jobId)
    .is("deleted_at", null);
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לבטל את הייבוא."));
  if (entity === "contact") {
    const companiesError = await trashImportedCompanies(context.supabase, orgId, jobId);
    if (companiesError) return fail(companiesError);
  }
  const { error: jobError } = await context.supabase
    .from("import_jobs")
    .update({ status: "undone", undone_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", jobId);
  if (jobError) return fail(dbErrorMessage(jobError, "הרשומות הועברו לסל המחזור, אבל לא הצלחנו לעדכן את סטטוס הייבוא."));
  revalidatePath(paths.imports(orgId));
  revalidatePath(paths.org(orgId), "layout");
  return ok();
}
