"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { readAllPages } from "@/lib/paged-read";
import { paths } from "@/lib/paths";
import { productsPath } from "@/features/products/paths";

import {
  CHUNK_SIZE,
  CUSTOM_PREFIX,
  duplicateModesFor,
  IMPORT_TABLES,
  IMPORT_TARGETS,
  MAX_IMPORT_ROWS,
  type DuplicateModeKey,
  type RecordImportEntity,
} from "./fields";
import { consentDeclarationSchema, mapsConsent } from "./consent";
import { DealImportStopped, loadDealLookups, processDealChunk, type DealImportContext } from "./deal-server";
import { loadProductLookups, processProductChunk, ProductImportStopped, type ProductImportContext } from "./product-server";
import { loadTaskLookups, processTaskChunk, TaskImportStopped, type TaskImportContext } from "./task-server";
import { ImportStopped, loadLookups, processChunk, type ImportContext, type RowOutcome } from "./server";

const entitySchema = z.enum(["lead", "contact", "company", "product", "deal", "task"]);
const modeSchema = z.enum(["skip", "update", "create"]);
const cellsSchema = z.array(z.array(z.string().max(10_000)).max(200)).max(CHUNK_SIZE);
const mappingSchema = z.array(z.string().max(100)).max(200);

const UNDO_DAYS = 7;

const CONSENT_DECLARATION_NEEDED = "כשמייבאים עמודת הסכמה צריך לבחור איך התקבלו ההסכמות. חזרו למיפוי ובחרו.";

const PRODUCTS_FOR_ADMINS = "ייבוא מוצרים מותר לבעלים, למנהלי מערכת ולמי שקיבל הרשאה לעריכת הקטלוג.";

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

/**
 * PRD-05: the catalog is written by owners and admins, and (PRM-01) by a member with the
 * catalog permission (RLS refuses others row by row; say it once, up front).
 */
async function mayImportProducts(supabase: Supabase, orgId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("my_permissions", { p_org: orgId });
  // a failed read answers "no": the user sees the rule and can try again
  if (error) return false;
  return (data ?? []).includes("edit_catalog");
}

/** The caller's active role in the organization, or null (a failed read answers null). */
async function myRole(supabase: Supabase, orgId: string, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) return null;
  return data?.role ?? null;
}

/** PRD-05: products have no custom fields; only their own columns can be mapped. */
async function productContext(orgId: string, mapping: string[]) {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  if (!(await mayImportProducts(context.supabase, orgId))) return fail(PRODUCTS_FOR_ADMINS);
  const allowed = new Set([...IMPORT_TARGETS.product.map((t) => t.key), ""]);
  if (!mapping.every((target) => allowed.has(target))) {
    return fail("בחירת השדות לא נשמרה. בחרו שוב לאיזה שדה כל עמודה נכנסת.");
  }
  if (!mapping.includes("name")) {
    return fail("יש לבחור את העמודה של שם המוצר.");
  }
  const ctx: ProductImportContext = { supabase: context.supabase, orgId, mapping };
  return { ok: true as const, ctx };
}

const MAPPING_LOST = "בחירת השדות לא נשמרה. בחרו שוב לאיזה שדה כל עמודה נכנסת.";

/** IMP-03: a deals import maps the deal's own columns and its custom fields; the name is required. */
async function dealContext(orgId: string, mapping: string[]) {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const definitions = await listFieldDefinitions(orgId, "deal");
  const allowed = new Set([...IMPORT_TARGETS.deal.map((t) => t.key), ...definitions.map((d) => `${CUSTOM_PREFIX}${d.key}`), ""]);
  if (!mapping.every((target) => allowed.has(target))) return fail(MAPPING_LOST);
  if (!mapping.includes("name")) return fail("יש לבחור את העמודה של שם העסקה.");
  const ctx: DealImportContext = { supabase: context.supabase, orgId, mapping, definitions };
  return { ok: true as const, ctx };
}

/** IMP-03: tasks have no custom fields; the title is required. */
async function taskContext(orgId: string, mapping: string[]) {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const allowed = new Set([...IMPORT_TARGETS.task.map((t) => t.key), ""]);
  if (!mapping.every((target) => allowed.has(target))) return fail(MAPPING_LOST);
  if (!mapping.includes("title")) return fail("יש לבחור את העמודה של כותרת המשימה.");
  const ctx: TaskImportContext = { supabase: context.supabase, orgId, mapping };
  return { ok: true as const, ctx };
}

/** Runs one chunk of a deals or tasks import (preview when jobId is null). */
async function dealOrTaskChunk(
  orgId: string,
  entity: "deal" | "task",
  mapping: string[],
  rows: string[][],
  firstRow: number,
  jobId: string | null,
): Promise<ActionResult<{ outcomes: RowOutcome[]; stopped: string | null }>> {
  try {
    if (entity === "deal") {
      const prepared = await dealContext(orgId, mapping);
      if (!prepared.ok) return prepared;
      return ok(await processDealChunk(prepared.ctx, jobId ? await loadDealLookups(prepared.ctx) : null, rows, firstRow, jobId));
    }
    const prepared = await taskContext(orgId, mapping);
    if (!prepared.ok) return prepared;
    return ok(await processTaskChunk(prepared.ctx, jobId ? await loadTaskLookups(prepared.ctx) : null, rows, firstRow, jobId));
  } catch (error) {
    if (error instanceof DealImportStopped || error instanceof TaskImportStopped) {
      return jobId ? ok({ outcomes: [], stopped: error.message }) : fail(error.message);
    }
    throw error;
  }
}

async function importContext(orgId: string, entity: RecordImportEntity, mode: DuplicateModeKey, mapping: string[]) {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const definitions = await listFieldDefinitions(orgId, entity);
  const allowed = new Set([...IMPORT_TARGETS[entity].map((t) => t.key), ...definitions.map((d) => `${CUSTOM_PREFIX}${d.key}`), ""]);
  if (!mapping.every((target) => allowed.has(target))) {
    return fail("בחירת השדות לא נשמרה. בחרו שוב לאיזה שדה כל עמודה נכנסת.");
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
  if (entity.data === "deal" || entity.data === "task") {
    const result = await dealOrTaskChunk(orgId, entity.data, mapping.data, rows.data, 1, null);
    return result.ok ? ok(result.data?.outcomes ?? []) : result;
  }
  if (entity.data === "product") {
    const product = await productContext(orgId, mapping.data);
    if (!product.ok) return product;
    try {
      return ok((await processProductChunk(product.ctx, null, rows.data, 1, null)).outcomes);
    } catch (error) {
      if (error instanceof ProductImportStopped) return fail(error.message);
      throw error;
    }
  }
  const prepared = await importContext(orgId, entity.data, mode.data, mapping.data);
  if (!prepared.ok) return prepared;
  try {
    return ok(await processChunk(prepared.ctx, null, rows.data, 1, null));
  } catch (error) {
    // a lookup the check cannot do without (the list of reasons)
    if (error instanceof ImportStopped) return fail(error.message);
    throw error;
  }
}

/** Creates the import job; the browser then sends the rows chunk by chunk. */
export async function startImportAction(
  orgId: string,
  input: {
    entity: string;
    mode: string;
    fileName: string;
    totalRows: number;
    mapsCompany?: boolean;
    // CNS-05: where the file's marketing consents came from; required when a consent column is mapped
    consent?: { method: string; note: string } | null;
  },
): Promise<ActionResult<{ jobId: string }>> {
  if (
    !validArg(
      z.object({
        entity: z.string(),
        mode: z.string(),
        fileName: z.string().max(2000),
        totalRows: z.number(),
        mapsCompany: z.boolean().optional(),
        consent: z.object({ method: z.string().max(40), note: z.string().max(2000) }).nullable().optional(),
      }),
      input,
    )
  ) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const entity = entitySchema.safeParse(input.entity);
  const mode = modeSchema.safeParse(input.mode);
  if (!entity.success || !mode.success || !Number.isInteger(input.totalRows) || input.totalRows < 1 || input.totalRows > MAX_IMPORT_ROWS) {
    return fail("הקובץ אינו תקין.");
  }
  if (!duplicateModesFor(entity.data).includes(mode.data)) {
    return fail("הקובץ אינו תקין.");
  }
  if (entity.data === "product" && !(await mayImportProducts(context.supabase, orgId))) {
    return fail(PRODUCTS_FOR_ADMINS);
  }
  let consent: { consent_method: string; consent_note: string } | null = null;
  if (input.consent) {
    if (entity.data !== "lead" && entity.data !== "contact") return fail("הקובץ אינו תקין.");
    const declared = consentDeclarationSchema.safeParse(input.consent);
    if (!declared.success) return fail(declared.error.issues[0]?.message ?? CONSENT_DECLARATION_NEEDED);
    consent = { consent_method: declared.data.method, consent_note: declared.data.note };
  }
  const { data, error } = await context.supabase
    .from("import_jobs")
    .insert({
      organization_id: orgId,
      entity_type: entity.data,
      duplicate_mode: mode.data,
      file_name: (input.fileName || "file").slice(0, 255),
      total_rows: input.totalRows,
      maps_company: entity.data === "contact" && input.mapsCompany === true,
      ...(consent ?? {}),
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
    .select("entity_type, duplicate_mode, status, created_by, consent_method")
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
  if (entity === "deal" || entity === "task") {
    return dealOrTaskChunk(orgId, entity, mapping.data, rows.data, input.firstRow, jobId);
  }
  if (entity === "product") {
    const product = await productContext(orgId, mapping.data);
    if (!product.ok) return product;
    try {
      const lookups = await loadProductLookups(product.ctx);
      return ok(await processProductChunk(product.ctx, lookups, rows.data, input.firstRow, jobId));
    } catch (error) {
      if (error instanceof ProductImportStopped) return ok({ outcomes: [], stopped: error.message });
      throw error;
    }
  }
  // CNS-05: consent columns are written only under the importer's declaration, made when the job started
  if (mapsConsent(mapping.data) && !job.consent_method) return fail(CONSENT_DECLARATION_NEEDED);
  const prepared = await importContext(orgId, entity, modeSchema.parse(job.duplicate_mode), mapping.data);
  if (!prepared.ok) return prepared;
  prepared.ctx.consentDeclared = Boolean(job.consent_method);
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
  if (!validArg(z.object({ updated: z.number(), skipped: z.number(), failed: z.number(), stopped: z.boolean() }), input)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, jobId);
  if (!context.ok) return context;
  const { data: job, error: jobError } = await context.supabase.from("import_jobs").select("entity_type").eq("organization_id", orgId).eq("id", jobId).maybeSingle();
  if (jobError) return fail(dbErrorMessage(jobError));
  if (!job) return fail(NOT_FOUND_OR_FORBIDDEN);
  const entity = entitySchema.parse(job.entity_type);
  const { count } = await context.supabase
    .from(IMPORT_TABLES[entity])
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

class ReadFailed {
  constructor(readonly error: unknown) {}
}

/**
 * PRD-05: removes the products an import created, and only those (products have no recycle bin).
 * A product that a document uses by now cannot be removed (no action foreign key, 23503): it is
 * archived instead, like the product page does.
 */
async function removeImportedProducts(supabase: Supabase, orgId: string, jobId: string): Promise<string | null> {
  let ids: string[];
  try {
    const { rows } = await readAllPages(async (from, to) => {
      const { data, error } = await supabase
        .from("products")
        .select("id")
        .eq("organization_id", orgId)
        .eq("import_job_id", jobId)
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw new ReadFailed(error);
      return data;
    });
    ids = rows.map((r) => r.id);
  } catch (e) {
    if (e instanceof ReadFailed) return dbErrorMessage(e.error, "לא הצלחנו לקרוא את המוצרים שנוצרו בייבוא.");
    throw e;
  }
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { error } = await supabase.from("products").delete().eq("organization_id", orgId).eq("import_job_id", jobId).in("id", slice);
    if (!error) continue;
    if (error.code !== "23503") return dbErrorMessage(error, "לא הצלחנו לבטל את הייבוא.");
    // one of them is on a document: remove the others one by one, archive that one
    for (const id of slice) {
      const { error: rowError } = await supabase.from("products").delete().eq("organization_id", orgId).eq("import_job_id", jobId).eq("id", id);
      if (!rowError) continue;
      if (rowError.code !== "23503") return dbErrorMessage(rowError, "לא הצלחנו לבטל את הייבוא.");
      const { error: archiveError } = await supabase
        .from("products")
        .update({ archived_at: new Date().toISOString() })
        .eq("organization_id", orgId)
        .eq("id", id)
        .is("archived_at", null);
      if (archiveError) return dbErrorMessage(archiveError, "לא הצלחנו לבטל את הייבוא.");
    }
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
  // PRM-01 (owner, 15 October 2026): a member who holds the import permission undoes their own
  // import through undo_own_import(), which moves only the records nobody changed since and counts the rest
  if (entity !== "product" && (await myRole(context.supabase, orgId, context.user.id)) === "member") {
    const { data, error } = await context.supabase.rpc("undo_own_import", { p_org: orgId, p_job: jobId });
    if (error) return fail(dbErrorMessage(error, "לא הצלחנו לבטל את הייבוא."));
    const result = data as { done?: number; kept?: number } | null;
    const kept = result?.kept ?? 0;
    revalidatePath(paths.imports(orgId));
    revalidatePath(paths.org(orgId), "layout");
    return { ok: true, message: kept > 0 ? `הייבוא בוטל. לא בוטלו: ${kept}, כי שונו אחרי הייבוא.` : "הייבוא בוטל." };
  }
  if (entity === "product") {
    const removeError = await removeImportedProducts(context.supabase, orgId, jobId);
    if (removeError) return fail(removeError);
    const { error: jobError } = await context.supabase
      .from("import_jobs")
      .update({ status: "undone", undone_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .eq("id", jobId);
    if (jobError) return fail(dbErrorMessage(jobError, "המוצרים הוסרו, אבל לא הצלחנו לעדכן את סטטוס הייבוא."));
    revalidatePath(paths.imports(orgId));
    revalidatePath(productsPath(orgId));
    return ok();
  }
  // FXD-07: the records to the recycle bin (for contacts, also the companies the import made that no live contact
  // uses) and the import marked undone, in one call: all or nothing. A record the user may no longer change keeps the
  // whole import as it was.
  const { error } = await context.supabase.rpc("undo_import", { p_org: orgId, p_job: jobId });
  if (error) {
    if (error.hint === "import_undo:left") {
      const left = Number(error.details);
      const what = Number.isFinite(left) && left > 0 ? (left === 1 ? "רשומה אחת" : `${left} רשומות`) : "חלק מהרשומות";
      return fail(`${what} מהייבוא כבר אינן שלכם לשנות, ולכן הייבוא לא בוטל ושום רשומה לא הועברה לסל המחזור.`);
    }
    return fail(dbErrorMessage(error, "לא הצלחנו לבטל את הייבוא."));
  }
  revalidatePath(paths.imports(orgId));
  revalidatePath(paths.org(orgId), "layout");
  return ok();
}
