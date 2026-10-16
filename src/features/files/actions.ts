"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { subjectSchema, type TimelineSubject } from "@/features/activities/schema";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";

import { ALLOWED_TYPES, FILE_MAX_BYTES, FILES_BUCKET, uploadProblemMessage } from "./types";

const fileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1).max(FILE_MAX_BYTES),
  type: z.string().refine((t) => t in ALLOWED_TYPES),
});

// REC-07: a file on a timeline entry, and/or a new version of an earlier file
const linkSchema = z
  .object({ activityId: z.uuid().optional(), previousId: z.uuid().optional() })
  .strict();

const RECORD_PATH = {
  lead: paths.lead,
  contact: paths.contact,
  company: paths.company,
  deal: paths.deal,
} as const;

/**
 * Step 1 of an upload: the row (the database sets the path and checks the plan's
 * storage). The browser then uploads to that path with the user's session.
 */
export async function prepareUploadAction(
  orgId: string,
  subject: TimelineSubject,
  file: { name: string; size: number; type: string },
  link: { activityId?: string; previousId?: string } = {},
): Promise<{ ok: true; id: string; path: string } | { ok: false; message: string }> {
  if (!validArg(linkSchema, link)) return fail(INVALID_ARGS);
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) return fail(NOT_FOUND_OR_FORBIDDEN);
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) {
    if (file.size > FILE_MAX_BYTES) return fail(`הקובץ ${file.name} גדול מ-25 MB.`);
    return fail(`אי אפשר להעלות את סוג הקובץ של ${file.name}. אפשר: PDF, תמונות, Word, Excel, PowerPoint, טקסט, CSV ו-ZIP.`);
  }
  const { kind, id: recordId } = parsedSubject.data;
  const context = await actionContext(orgId, recordId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("files")
    .insert({
      organization_id: orgId,
      lead_id: kind === "lead" ? recordId : null,
      contact_id: kind === "contact" ? recordId : null,
      company_id: kind === "company" ? recordId : null,
      deal_id: kind === "deal" ? recordId : null,
      name: parsed.data.name,
      mime_type: parsed.data.type,
      size_bytes: parsed.data.size,
      activity_id: link.activityId ?? null,
      previous_id: link.previousId ?? null,
    })
    .select("id, storage_path")
    .single();
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו להתחיל את ההעלאה."));
  return { ok: true, id: data.id, path: data.storage_path };
}

/**
 * Step 2: the upload is done (or failed, and the row goes away). FXS-07: the database then reads what Storage really
 * holds; the row takes that size and type, or the object and the row are removed and the reason is answered.
 */
export async function finishUploadAction(orgId: string, subject: TimelineSubject, fileId: string, uploaded: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, uploaded)) return fail(INVALID_ARGS);
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success || !isUuid(fileId)) return fail(NOT_FOUND_OR_FORBIDDEN);
  const context = await actionContext(orgId, fileId);
  if (!context.ok) return context;
  const recordPath = RECORD_PATH[parsedSubject.data.kind](orgId, parsedSubject.data.id);
  if (!uploaded) {
    await context.supabase.from("files").delete().eq("organization_id", orgId).eq("id", fileId);
    revalidatePath(recordPath);
    return ok();
  }
  const { data: verdict, error } = await context.supabase.rpc("confirm_file_upload", { p_org: orgId, p_file: fileId });
  // not answered: the row keeps waiting (hidden); pg_cron crm-file-confirm checks it within minutes
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לסיים את ההעלאה. נסו שוב."));
  const answer = (verdict ?? {}) as { ok?: boolean; reason?: string };
  if (answer.ok !== true) {
    const { data: file, error: readError } = await context.supabase.from("files").select("storage_path").eq("organization_id", orgId).eq("id", fileId).maybeSingle();
    // a failed read leaves the row waiting (hidden); the refusal is still answered
    if (!readError && file) await context.supabase.storage.from(FILES_BUCKET).remove([file.storage_path]);
    await context.supabase.from("files").delete().eq("organization_id", orgId).eq("id", fileId);
    revalidatePath(recordPath);
    return fail(uploadProblemMessage(answer.reason));
  }
  revalidatePath(recordPath);
  return ok();
}

/** Deletes a file: the object first (its policy needs the row), then the row. */
export async function deleteFileAction(orgId: string, subject: TimelineSubject, fileId: string): Promise<ActionResult> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success || !isUuid(fileId)) return fail(NOT_FOUND_OR_FORBIDDEN);
  const context = await actionContext(orgId, fileId);
  if (!context.ok) return context;
  const { data: file, error: fileError } = await context.supabase.from("files").select("storage_path").eq("organization_id", orgId).eq("id", fileId).maybeSingle();
  if (fileError) return fail(dbErrorMessage(fileError));
  if (!file) return fail(NOT_FOUND_OR_FORBIDDEN);
  const { data: removed, error: storageError } = await context.supabase.storage.from(FILES_BUCKET).remove([file.storage_path]);
  if (storageError) return fail("לא הצלחנו למחוק את הקובץ. נסו שוב.");
  const { data, error } = await context.supabase.from("files").delete().eq("organization_id", orgId).eq("id", fileId).select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו למחוק."));
  // nothing removed and no row deleted: not permitted (only the uploader and admins delete)
  if (data.length === 0) return fail(removed?.length ? "לא הצלחנו למחוק." : "רק מי שהעלה את הקובץ או מנהל מערכת יכולים למחוק אותו.");
  revalidatePath(RECORD_PATH[parsedSubject.data.kind](orgId, parsedSubject.data.id));
  return ok();
}
