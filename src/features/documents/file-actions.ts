"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { FILE_MAX_BYTES, FILES_BUCKET, isDocumentFileType, DOCUMENT_TYPE_PROBLEM, uploadProblemMessage } from "@/features/files/types";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

// DOC-01 follow-up: the file of a recorded accounting document (a PDF or an image of what was issued), through the shared
// files mechanism with the user's session. The database decides: whoever may record documents adds one to a document they
// read; it links a new file to the document's latest one, so the document has one current file and its earlier ones stay
// as versions; the uploader or an admin removes one.

const subjectSchema = z.object({ kind: z.enum(["deal", "contact"]), id: z.guid() });
type Subject = z.infer<typeof subjectSchema>;

const fileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1).max(FILE_MAX_BYTES),
  type: z.string().refine(isDocumentFileType),
});

const CANNOT = "אין לכם הרשאה לצרף קבצים למסמך הזה. מצרפים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום מסמכים.";
const pageOf = (orgId: string, subject: Subject) => (subject.kind === "deal" ? paths.deal(orgId, subject.id) : paths.contact(orgId, subject.id));

/** Step 1: the row (the database checks the rights, the type, the plan's storage and links it to the latest file). */
export async function prepareDocumentFileAction(
  orgId: string,
  subject: Subject,
  documentId: string,
  file: { name: string; size: number; type: string },
  previousId: string | null,
): Promise<{ ok: true; id: string; path: string } | { ok: false; message: string }> {
  if (!validArg(subjectSchema, subject) || !validArg(z.guid().nullable(), previousId)) return fail(INVALID_ARGS);
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) {
    if (file.size > FILE_MAX_BYTES) return fail(`הקובץ ${file.name} גדול מ-25 MB.`);
    return fail(DOCUMENT_TYPE_PROBLEM);
  }
  const context = await actionContext(orgId, subject.id, documentId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("files")
    .insert({
      organization_id: orgId,
      accounting_document_id: documentId,
      name: parsed.data.name,
      mime_type: parsed.data.type,
      size_bytes: parsed.data.size,
      previous_id: previousId,
    })
    .select("id, storage_path")
    .single();
  if (error) return fail(error.code === "42501" ? CANNOT : dbErrorMessage(error, "לא הצלחנו להתחיל את ההעלאה."));
  return { ok: true, id: data.id, path: data.storage_path };
}

/**
 * Step 2: the upload is done (or failed, and the row goes away). The database reads what Storage really holds: a
 * document's file must really be a PDF or an image; otherwise the object and the row are removed and the reason answered.
 */
export async function finishDocumentFileAction(orgId: string, subject: Subject, fileId: string, uploaded: boolean): Promise<ActionResult> {
  if (!validArg(subjectSchema, subject) || !validArg(booleanArg, uploaded)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, fileId);
  if (!context.ok) return context;
  if (!uploaded) {
    await context.supabase.from("files").delete().eq("organization_id", orgId).eq("id", fileId);
    revalidatePath(pageOf(orgId, subject));
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
    revalidatePath(pageOf(orgId, subject));
    return fail(answer.reason === "type" ? DOCUMENT_TYPE_PROBLEM : uploadProblemMessage(answer.reason));
  }
  revalidatePath(pageOf(orgId, subject));
  return ok();
}

/** Removes one file of a document: the object first (its policy needs the row), then the row. */
export async function deleteDocumentFileAction(orgId: string, subject: Subject, fileId: string): Promise<ActionResult> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, fileId);
  if (!context.ok) return context;
  const { data: file, error: fileError } = await context.supabase
    .from("files")
    .select("storage_path")
    .eq("organization_id", orgId)
    .eq("id", fileId)
    .not("accounting_document_id", "is", null)
    .maybeSingle();
  if (fileError) return fail(dbErrorMessage(fileError));
  if (!file) return fail(NOT_FOUND_OR_FORBIDDEN);
  const { data: removed, error: storageError } = await context.supabase.storage.from(FILES_BUCKET).remove([file.storage_path]);
  if (storageError) return fail("לא הצלחנו למחוק את הקובץ. נסו שוב.");
  const { data, error } = await context.supabase.from("files").delete().eq("organization_id", orgId).eq("id", fileId).select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו למחוק."));
  // nothing removed and no row deleted: not permitted (the uploader or an admin, who may also record documents)
  if (data.length === 0) return fail(removed?.length ? "לא הצלחנו למחוק." : "רק מי שהעלה את הקובץ או מנהל מערכת יכולים למחוק אותו.");
  revalidatePath(pageOf(orgId, subject));
  return ok();
}
