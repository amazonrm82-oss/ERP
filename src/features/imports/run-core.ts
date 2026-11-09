import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";

import { consentDeclarationSchema, mapsConsent } from "./consent";
import { DealImportStopped, loadDealLookups, processDealChunk, type DealImportContext } from "./deal-server";
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
import { mapsOpeningBalance, OPENING_ADMINS_ONLY } from "./opening-balance";
import { loadProductLookups, processProductChunk, ProductImportStopped, type ProductImportContext } from "./product-server";
import { ImportStopped, loadLookups, processChunk, type ImportContext, type RowOutcome } from "./server";
import { loadTaskLookups, processTaskChunk, TaskImportStopped, type TaskImportContext } from "./task-server";

// IMP-04: the import's steps, shared by the browser path (the Server Actions in actions.ts, with the user's own
// session) and the background path (src/features/background/, with a short-lived token of the person who ordered it).
// Both hand in the client they act with and the person's id; nothing here reads cookies, so the two paths run the
// same code and the database judges every write by the same person's rights.

export type ImportSession = { supabase: SupabaseClient<Database>; userId: string };

export const entitySchema = z.enum(["lead", "contact", "company", "product", "deal", "task"]);
export const modeSchema = z.enum(["skip", "update", "create"]);
export const cellsSchema = z.array(z.array(z.string().max(10_000)).max(200)).max(CHUNK_SIZE);
export const mappingSchema = z.array(z.string().max(100)).max(200);

export const CONSENT_DECLARATION_NEEDED = "כשמייבאים עמודת הסכמה צריך לבחור איך התקבלו ההסכמות. חזרו למיפוי ובחרו.";
export const PRODUCTS_FOR_ADMINS = "ייבוא מוצרים מותר לבעלים, למנהלי מערכת ולמי שקיבל הרשאה לעריכת הקטלוג.";
const MAPPING_LOST = "בחירת השדות לא נשמרה. בחרו שוב לאיזה שדה כל עמודה נכנסת.";

type Supabase = SupabaseClient<Database>;

/**
 * PRD-05: the catalog is written by owners and admins, and (PRM-01) by a member with the
 * catalog permission (RLS refuses others row by row; say it once, up front).
 */
export async function mayImportProducts(supabase: Supabase, orgId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("my_permissions", { p_org: orgId });
  // a failed read answers "no": the user sees the rule and can try again
  if (error) return false;
  return (data ?? []).includes("edit_catalog");
}

/** The caller's active role in the organization, or null (a failed read answers null). */
export async function myRole(supabase: Supabase, orgId: string, userId: string): Promise<string | null> {
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
export async function productContext(session: ImportSession, orgId: string, mapping: string[]) {
  if (!(await mayImportProducts(session.supabase, orgId))) return fail(PRODUCTS_FOR_ADMINS);
  const allowed = new Set([...IMPORT_TARGETS.product.map((t) => t.key), ""]);
  if (!mapping.every((target) => allowed.has(target))) {
    return fail(MAPPING_LOST);
  }
  if (!mapping.includes("name")) {
    return fail("יש לבחור את העמודה של שם המוצר.");
  }
  const ctx: ProductImportContext = { supabase: session.supabase, orgId, mapping };
  return { ok: true as const, ctx };
}

/** IMP-03: a deals import maps the deal's own columns and its custom fields; the name is required. */
async function dealContext(session: ImportSession, orgId: string, mapping: string[]) {
  const definitions = await listFieldDefinitions(orgId, "deal", { client: session.supabase });
  const allowed = new Set([...IMPORT_TARGETS.deal.map((t) => t.key), ...definitions.map((d) => `${CUSTOM_PREFIX}${d.key}`), ""]);
  if (!mapping.every((target) => allowed.has(target))) return fail(MAPPING_LOST);
  if (!mapping.includes("name")) return fail("יש לבחור את העמודה של שם העסקה.");
  const ctx: DealImportContext = { supabase: session.supabase, orgId, mapping, definitions };
  return { ok: true as const, ctx };
}

/** IMP-03: tasks have no custom fields; the title is required. */
async function taskContext(session: ImportSession, orgId: string, mapping: string[]) {
  const allowed = new Set([...IMPORT_TARGETS.task.map((t) => t.key), ""]);
  if (!mapping.every((target) => allowed.has(target))) return fail(MAPPING_LOST);
  if (!mapping.includes("title")) return fail("יש לבחור את העמודה של כותרת המשימה.");
  const ctx: TaskImportContext = { supabase: session.supabase, orgId, mapping };
  return { ok: true as const, ctx };
}

/** Runs one chunk of a deals or tasks import (preview when jobId is null). */
export async function dealOrTaskChunk(
  session: ImportSession,
  orgId: string,
  entity: "deal" | "task",
  mapping: string[],
  rows: string[][],
  firstRow: number,
  jobId: string | null,
): Promise<ActionResult<{ outcomes: RowOutcome[]; stopped: string | null }>> {
  try {
    if (entity === "deal") {
      const prepared = await dealContext(session, orgId, mapping);
      if (!prepared.ok) return prepared;
      return ok(await processDealChunk(prepared.ctx, jobId ? await loadDealLookups(prepared.ctx) : null, rows, firstRow, jobId));
    }
    const prepared = await taskContext(session, orgId, mapping);
    if (!prepared.ok) return prepared;
    return ok(await processTaskChunk(prepared.ctx, jobId ? await loadTaskLookups(prepared.ctx) : null, rows, firstRow, jobId));
  } catch (error) {
    if (error instanceof DealImportStopped || error instanceof TaskImportStopped) {
      return jobId ? ok({ outcomes: [], stopped: error.message }) : fail(error.message);
    }
    throw error;
  }
}

export async function importContext(session: ImportSession, orgId: string, entity: RecordImportEntity, mode: DuplicateModeKey, mapping: string[]) {
  const definitions = await listFieldDefinitions(orgId, entity, { client: session.supabase });
  const allowed = new Set([...IMPORT_TARGETS[entity].map((t) => t.key), ...definitions.map((d) => `${CUSTOM_PREFIX}${d.key}`), ""]);
  if (!mapping.every((target) => allowed.has(target))) {
    return fail(MAPPING_LOST);
  }
  if (!mapping.some(Boolean)) {
    return fail("יש לבחור לפחות עמודה אחת לייבוא.");
  }
  // GAP-12: an opening balance column is for owners and admins only (public.opening_balance_set refuses anyone else too)
  if (mapsOpeningBalance(mapping)) {
    const role = await myRole(session.supabase, orgId, session.userId);
    if (role !== "owner" && role !== "admin") return fail(OPENING_ADMINS_ONLY);
  }
  const ctx: ImportContext = { supabase: session.supabase, orgId, userId: session.userId, entity, mode, mapping, definitions };
  return { ok: true as const, ctx };
}

export type StartImportInput = {
  entity: string;
  mode: string;
  fileName: string;
  totalRows: number;
  mapsCompany?: boolean;
  // CNS-05: where the file's marketing consents came from; required when a consent column is mapped
  consent?: { method: string; note: string } | null;
};

/** Creates the import job with the session's own rights. */
export async function startImportCore(session: ImportSession, orgId: string, input: StartImportInput): Promise<ActionResult<{ jobId: string }>> {
  const entity = entitySchema.safeParse(input.entity);
  const mode = modeSchema.safeParse(input.mode);
  if (!entity.success || !mode.success || !Number.isInteger(input.totalRows) || input.totalRows < 1 || input.totalRows > MAX_IMPORT_ROWS) {
    return fail("הקובץ אינו תקין.");
  }
  if (!duplicateModesFor(entity.data).includes(mode.data)) {
    return fail("הקובץ אינו תקין.");
  }
  if (entity.data === "product" && !(await mayImportProducts(session.supabase, orgId))) {
    return fail(PRODUCTS_FOR_ADMINS);
  }
  let consent: { consent_method: string; consent_note: string } | null = null;
  if (input.consent) {
    if (entity.data !== "lead" && entity.data !== "contact") return fail("הקובץ אינו תקין.");
    const declared = consentDeclarationSchema.safeParse(input.consent);
    if (!declared.success) return fail(declared.error.issues[0]?.message ?? CONSENT_DECLARATION_NEEDED);
    consent = { consent_method: declared.data.method, consent_note: declared.data.note };
  }
  const { data, error } = await session.supabase
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

/** Writes one chunk of rows into a running job of the session's person. */
export async function importChunkCore(
  session: ImportSession,
  orgId: string,
  jobId: string,
  input: { mapping: string[]; rows: string[][]; firstRow: number },
): Promise<ActionResult<{ outcomes: RowOutcome[]; stopped: string | null }>> {
  const mapping = mappingSchema.safeParse(input.mapping);
  const rows = cellsSchema.safeParse(input.rows);
  if (!mapping.success || !rows.success || !Number.isInteger(input.firstRow) || input.firstRow < 1) {
    return fail("הנתונים שנשלחו אינם תקינים.");
  }
  const { supabase } = session;
  // the job decides the object and the duplicate rule, not the browser
  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .select("entity_type, duplicate_mode, status, created_by, consent_method")
    .eq("organization_id", orgId)
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) return fail(dbErrorMessage(jobError));
  if (!job || job.created_by !== session.userId) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  // marks the job as alive (updated_at); a job idle for 10 minutes is closed by the database (FXC-03)
  const { data: alive, error: aliveError } = await supabase
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
    return dealOrTaskChunk(session, orgId, entity, mapping.data, rows.data, input.firstRow, jobId);
  }
  if (entity === "product") {
    const product = await productContext(session, orgId, mapping.data);
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
  const prepared = await importContext(session, orgId, entity, modeSchema.parse(job.duplicate_mode), mapping.data);
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
export async function finishImportCore(
  session: ImportSession,
  orgId: string,
  jobId: string,
  input: { updated: number; skipped: number; failed: number; stopped: boolean },
): Promise<ActionResult> {
  const { supabase } = session;
  const { data: job, error: jobError } = await supabase.from("import_jobs").select("entity_type").eq("organization_id", orgId).eq("id", jobId).maybeSingle();
  if (jobError) return fail(dbErrorMessage(jobError));
  if (!job) return fail(NOT_FOUND_OR_FORBIDDEN);
  const entity = entitySchema.parse(job.entity_type);
  const { count } = await supabase
    .from(IMPORT_TABLES[entity])
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("import_job_id", jobId);
  const clamp = (n: number) => (Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_IMPORT_ROWS) : 0);
  const { data, error } = await supabase
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
  return ok();
}
