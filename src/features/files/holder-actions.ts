"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import type { FileHolder, HolderPage } from "./holder";
import { ATTACHMENT_TYPE_PROBLEM, FILE_MAX_BYTES, FILES_BUCKET, isDocumentFileType, uploadProblemMessage } from "./types";

// DOC-01 / PAY-01 follow-ups: the file of a recorded accounting document or payment (a PDF or an image of the paper),
// through the shared files mechanism with the user's session. The database decides: whoever may record documents
// (payments) adds one to a document (payment) they read; it links a new file to the latest one, so each has one current
// file and its earlier ones stay as versions. Nobody removes one (owner, 20 October 2026): only an upload that never
// arrived goes, here, by its uploader.

const pageSchema = z.object({ kind: z.enum(["deal", "contact"]), id: z.guid() });
const holderSchema = z.object({ kind: z.enum(["document", "payment"]), id: z.guid() });

const fileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1).max(FILE_MAX_BYTES),
  type: z.string().refine(isDocumentFileType),
});

const CANNOT: Record<FileHolder["kind"], string> = {
  document: "אין לכם הרשאה לצרף קבצים למסמך הזה. מצרפים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום מסמכים.",
  payment: "אין לכם הרשאה לצרף קבצים לתשלום הזה. מצרפים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים.",
};
const pageOf = (orgId: string, page: HolderPage) => (page.kind === "deal" ? paths.deal(orgId, page.id) : paths.contact(orgId, page.id));

/** Step 1: the row (the database checks the rights, the type, the plan's storage and links it to the latest file). */
export async function prepareHolderFileAction(
  orgId: string,
  page: HolderPage,
  holder: FileHolder,
  file: { name: string; size: number; type: string },
  previousId: string | null,
): Promise<{ ok: true; id: string; path: string } | { ok: false; message: string }> {
  if (!validArg(pageSchema, page) || !validArg(holderSchema, holder) || !validArg(z.guid().nullable(), previousId)) return fail(INVALID_ARGS);
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) {
    if (file.size > FILE_MAX_BYTES) return fail(`הקובץ ${file.name} גדול מ-25 MB.`);
    return fail(ATTACHMENT_TYPE_PROBLEM);
  }
  const context = await actionContext(orgId, page.id, holder.id);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("files")
    .insert({
      organization_id: orgId,
      accounting_document_id: holder.kind === "document" ? holder.id : null,
      payment_id: holder.kind === "payment" ? holder.id : null,
      name: parsed.data.name,
      mime_type: parsed.data.type,
      size_bytes: parsed.data.size,
      previous_id: previousId,
    })
    .select("id, storage_path")
    .single();
  if (error) return fail(error.code === "42501" ? CANNOT[holder.kind] : dbErrorMessage(error, "לא הצלחנו להתחיל את ההעלאה."));
  return { ok: true, id: data.id, path: data.storage_path };
}

/**
 * Step 2: the upload is done (or failed, and the row goes away). The database reads what Storage really holds: the file
 * must really be a PDF or an image; otherwise the object and the row are removed and the reason answered.
 */
export async function finishHolderFileAction(orgId: string, page: HolderPage, fileId: string, uploaded: boolean): Promise<ActionResult> {
  if (!validArg(pageSchema, page) || !validArg(booleanArg, uploaded)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, fileId);
  if (!context.ok) return context;
  if (!uploaded) {
    await context.supabase.from("files").delete().eq("organization_id", orgId).eq("id", fileId);
    revalidatePath(pageOf(orgId, page));
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
    revalidatePath(pageOf(orgId, page));
    return fail(answer.reason === "type" ? ATTACHMENT_TYPE_PROBLEM : uploadProblemMessage(answer.reason));
  }
  revalidatePath(pageOf(orgId, page));
  return ok();
}

