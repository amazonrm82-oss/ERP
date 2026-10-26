"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ALLOWED_TYPES, FILE_MAX_BYTES, FILES_BUCKET, uploadProblemMessage } from "@/features/files/types";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { RECORD_TYPES } from "@/lib/record-types";

import { requiredFileRemovalProblem } from "./server";
import { FIELD_OBJECTS } from "./types";

// FLD-06 part B: a file field's file. Like a record's files (prepareUploadAction / finishUploadAction): a row first (the
// database checks the field, the rights, the storage and the waiting cap), the object straight to Storage with the user's
// session, then confirm_file_upload reads what arrived. Only then the record's value names the file, with the user's
// session (the database checks it is this record's confirmed file of this field); the file it replaces is kept by the
// database as the new file's earlier version (owner, 26 October 2026, answer (ב)), listed with the record's files. Clearing
// the field releases its current file. Everything here uses the user's session.

const fileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1).max(FILE_MAX_BYTES),
  type: z.string().refine((t) => t in ALLOWED_TYPES),
});
const targetSchema = z.object({
  object: z.enum(FIELD_OBJECTS),
  recordId: z.uuid(),
  key: z.string().regex(/^[a-z0-9_]{1,100}$/),
});
export type FieldFileTarget = z.infer<typeof targetSchema>;

function recordPath(orgId: string, target: FieldFileTarget): string {
  const page = RECORD_TYPES[target.object].page;
  return page ? page(orgId, target.recordId) : RECORD_TYPES[target.object].list(orgId);
}

/** Step 1: the files row of the field. */
export async function prepareFieldFileAction(
  orgId: string,
  target: FieldFileTarget,
  file: { name: string; size: number; type: string },
): Promise<{ ok: true; id: string; path: string } | { ok: false; message: string }> {
  if (!validArg(targetSchema, target)) return fail(INVALID_ARGS);
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) {
    if (file?.size > FILE_MAX_BYTES) return fail(`הקובץ ${file.name} גדול מ-25 MB.`);
    return fail("אי אפשר להעלות את סוג הקובץ הזה. אפשר: PDF, תמונות, Word, Excel, PowerPoint, טקסט, CSV ו-ZIP.");
  }
  const context = await actionContext(orgId, target.recordId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("files")
    .insert({
      organization_id: orgId,
      lead_id: target.object === "lead" ? target.recordId : null,
      contact_id: target.object === "contact" ? target.recordId : null,
      company_id: target.object === "company" ? target.recordId : null,
      deal_id: target.object === "deal" ? target.recordId : null,
      name: parsed.data.name,
      mime_type: parsed.data.type,
      size_bytes: parsed.data.size,
      custom_field_key: target.key,
    })
    .select("id, storage_path")
    .single();
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו להתחיל את ההעלאה."));
  return { ok: true, id: data.id, path: data.storage_path };
}

/** Removes an upload that will not be the field's value (its own uploader's row is not in use, so it may go). */
async function dropUpload(supabase: Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"], orgId: string, fileId: string) {
  const { data: row, error } = await supabase.from("files").select("storage_path").eq("organization_id", orgId).eq("id", fileId).maybeSingle();
  if (!error && row) await supabase.storage.from(FILES_BUCKET).remove([row.storage_path]);
  await supabase.from("files").delete().eq("organization_id", orgId).eq("id", fileId);
}

/** Step 2: the upload is done (or failed); a confirmed file becomes the field's value. */
export async function finishFieldFileAction(orgId: string, target: FieldFileTarget, fileId: string, uploaded: boolean): Promise<ActionResult> {
  if (!validArg(targetSchema, target) || !validArg(booleanArg, uploaded)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, target.recordId, fileId);
  if (!context.ok) return context;
  if (!uploaded) {
    await dropUpload(context.supabase, orgId, fileId);
    return ok();
  }
  const { data: verdict, error } = await context.supabase.rpc("confirm_file_upload", { p_org: orgId, p_file: fileId });
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לסיים את ההעלאה. נסו שוב."));
  const answer = (verdict ?? {}) as { ok?: boolean; reason?: string };
  if (answer.ok !== true) {
    await dropUpload(context.supabase, orgId, fileId);
    return fail(uploadProblemMessage(answer.reason));
  }
  const { data, error: updateError } = await context.supabase
    .from(RECORD_TYPES[target.object].table as "leads" | "contacts" | "companies" | "deals")
    .update({ custom_fields: { $merge: { [target.key]: fileId } } })
    .eq("organization_id", orgId)
    .eq("id", target.recordId)
    .select("id");
  if (updateError || data.length === 0) {
    await dropUpload(context.supabase, orgId, fileId);
    return fail(updateError ? dbErrorMessage(updateError, "לא הצלחנו לשמור את הקובץ בשדה.") : NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(recordPath(orgId, target));
  return ok();
}

/**
 * Empties a file field; the database releases its file (the object goes with the nightly cleanup). A required field's file
 * is replaced, never removed (owner, 26 October 2026, answer 3 (ב); app-only like "required").
 */
export async function removeFieldFileAction(orgId: string, target: FieldFileTarget): Promise<ActionResult> {
  if (!validArg(targetSchema, target)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, target.recordId);
  if (!context.ok) return context;
  const kept = await requiredFileRemovalProblem(orgId, target.object, target.recordId, target.key);
  if (kept) return fail(kept);
  const { data, error } = await context.supabase
    .from(RECORD_TYPES[target.object].table as "leads" | "contacts" | "companies" | "deals")
    .update({ custom_fields: { $merge: { [target.key]: null } } })
    .eq("organization_id", orgId)
    .eq("id", target.recordId)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו להסיר את הקובץ."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(recordPath(orgId, target));
  return ok();
}
