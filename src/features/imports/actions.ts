"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { readAllPages } from "@/lib/paged-read";
import { paths } from "@/lib/paths";
import { productsPath } from "@/features/products/paths";

import { consentsUndoneText } from "./consent";
import { openingsUndoneText } from "./opening-balance";
import { ProductImportStopped, processProductChunk } from "./product-server";
import {
  cellsSchema,
  dealOrTaskChunk,
  entitySchema,
  finishImportCore,
  importChunkCore,
  importContext,
  mappingSchema,
  modeSchema,
  myRole,
  productContext,
  startImportCore,
  type StartImportInput,
} from "./run-core";
import { ImportStopped, processChunk, type RowOutcome } from "./server";

const UNDO_DAYS = 7;

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

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
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const session = { supabase: context.supabase, userId: context.user.id };
  if (entity.data === "deal" || entity.data === "task") {
    const result = await dealOrTaskChunk(session, orgId, entity.data, mapping.data, rows.data, 1, null);
    return result.ok ? ok(result.data?.outcomes ?? []) : result;
  }
  if (entity.data === "product") {
    const product = await productContext(session, orgId, mapping.data);
    if (!product.ok) return product;
    try {
      return ok((await processProductChunk(product.ctx, null, rows.data, 1, null)).outcomes);
    } catch (error) {
      if (error instanceof ProductImportStopped) return fail(error.message);
      throw error;
    }
  }
  const prepared = await importContext(session, orgId, entity.data, mode.data, mapping.data);
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
export async function startImportAction(orgId: string, input: StartImportInput): Promise<ActionResult<{ jobId: string }>> {
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
  return startImportCore({ supabase: context.supabase, userId: context.user.id }, orgId, input);
}

/** Writes one chunk of rows into a running job of the user. */
export async function importChunkAction(
  orgId: string,
  jobId: string,
  input: { mapping: string[]; rows: string[][]; firstRow: number },
): Promise<ActionResult<{ outcomes: RowOutcome[]; stopped: string | null }>> {
  const context = await actionContext(orgId, jobId);
  if (!context.ok) return context;
  return importChunkCore({ supabase: context.supabase, userId: context.user.id }, orgId, jobId, input);
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
  const result = await finishImportCore({ supabase: context.supabase, userId: context.user.id }, orgId, jobId, input);
  if (!result.ok) return result;
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
    const result = data as { done?: number; kept?: number; consents?: number; opening_balances?: number } | null;
    const kept = result?.kept ?? 0;
    revalidatePath(paths.imports(orgId));
    revalidatePath(paths.org(orgId), "layout");
    const message = kept > 0 ? `הייבוא בוטל. לא בוטלו: ${kept}, כי שונו אחרי הייבוא.` : "הייבוא בוטל.";
    return { ok: true, message: `${message}${consentsUndoneText(result?.consents)}${openingsUndoneText(result?.opening_balances)}` };
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
  const { data: undone, error } = await context.supabase.rpc("undo_import", { p_org: orgId, p_job: jobId });
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
  const counts = undone as { consents?: number; opening_balances?: number } | null;
  const extra = `${consentsUndoneText(counts?.consents)}${openingsUndoneText(counts?.opening_balances)}`;
  return extra ? { ok: true, message: `הייבוא בוטל.${extra}` } : ok();
}
