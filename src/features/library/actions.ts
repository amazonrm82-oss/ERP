"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ALLOWED_TYPES, FILE_MAX_BYTES, FILES_BUCKET, uploadProblemMessage } from "@/features/files/types";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { libraryPath } from "./paths";
import { LIBRARY_ITEM_FIELDS, libraryCategorySchema, libraryFileItemSchema, libraryLinkSchema } from "./schema";

// LIB-01: the content library, with the user's session (RLS decides): owners, admins and managers of a writable business
// write items and their files; owners and admins manage the categories. A file item's file goes through the one upload
// path (a files row with library_item_id, the object straight to Storage, then confirm_file_upload).

const CANNOT_WRITE = "את ספריית התוכן עורכים בעלים, מנהלי מערכת ומנהלים.";
const CANNOT_CATEGORIES = "את הקטגוריות של ספריית התוכן מנהלים בעלים ומנהלי מערכת.";

/** The item form, as one shape: a file item's url is always null. */
function parseItem(kind: "link" | "file", formData: FormData) {
  const raw = pick(formData, LIBRARY_ITEM_FIELDS);
  if (kind === "link") return libraryLinkSchema.safeParse(raw);
  const file = libraryFileItemSchema.safeParse(raw);
  return file.success ? { success: true as const, data: { ...file.data, url: null as string | null } } : file;
}

function refresh(orgId: string) {
  revalidatePath(libraryPath(orgId));
}

/** A new item: a link, or a file item whose file is uploaded right after (the answer carries its id). */
export async function createLibraryItemAction(orgId: string, kind: "link" | "file", _prev: FormState<{ id: string }>, formData: FormData): Promise<FormState<{ id: string }>> {
  if (!validArg(z.enum(["link", "file"]), kind)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = parseItem(kind, formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = parsed.data;
  const { data, error } = await context.supabase
    .from("library_items")
    .insert({
      organization_id: orgId,
      kind,
      title: values.title,
      description: values.description,
      category_id: values.category_id,
      url: values.url,
      valid_from: values.valid_from,
      valid_until: values.valid_until,
      is_active: values.is_active,
    })
    .select("id")
    .single();
  if (error) {
    return fail(error.code === "42501" ? CANNOT_WRITE : dbErrorMessage(error, "לא הצלחנו לשמור את הפריט. נסו שוב."), { values: formValues(formData) });
  }
  refresh(orgId);
  return ok({ id: data.id }, "הפריט נשמר.");
}

/** Changes an item's details (its kind never changes). */
export async function updateLibraryItemAction(orgId: string, itemId: string, kind: "link" | "file", _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(z.enum(["link", "file"]), kind)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, itemId);
  if (!context.ok) return context;
  const parsed = parseItem(kind, formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = parsed.data;
  const { data, error } = await context.supabase
    .from("library_items")
    .update({
      title: values.title,
      description: values.description,
      category_id: values.category_id,
      ...(kind === "link" ? { url: values.url } : {}),
      valid_from: values.valid_from,
      valid_until: values.valid_until,
      is_active: values.is_active,
    })
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הפריט. נסו שוב."), { values: formValues(formData) });
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  refresh(orgId);
  return { ok: true, message: "השינוי נשמר." };
}

/** Deletes an item; its file row goes with it and the object waits for the nightly cleanup. */
export async function deleteLibraryItemAction(orgId: string, itemId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, itemId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("library_items").delete().eq("organization_id", orgId).eq("id", itemId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(CANNOT_WRITE);
  refresh(orgId);
  return ok();
}

const fileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1).max(FILE_MAX_BYTES),
  type: z.string().refine((t) => t in ALLOWED_TYPES),
});

/**
 * Step 1 of a file item's upload: the new row (the database checks the rights, the type and the plan's storage). The item's
 * current file stays until the new one is confirmed (step 2); only the caller's own unfinished uploads to this item go first.
 */
export async function prepareLibraryFileAction(
  orgId: string,
  itemId: string,
  file: { name: string; size: number; type: string },
): Promise<{ ok: true; id: string; path: string } | { ok: false; message: string }> {
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) {
    if (typeof file?.size === "number" && file.size > FILE_MAX_BYTES) return fail(`הקובץ ${file.name} גדול מ-25 MB.`);
    return fail(`אי אפשר להעלות את סוג הקובץ של ${file?.name ?? "הקובץ"}. אפשר: PDF, תמונות, Word, Excel, PowerPoint, טקסט, CSV ו-ZIP.`);
  }
  const context = await actionContext(orgId, itemId);
  if (!context.ok) return context;
  // an earlier upload of this person to this item that never finished (its object, if any, goes with the orphan cleanup)
  const { error: staleError } = await context.supabase
    .from("files")
    .delete()
    .eq("organization_id", orgId)
    .eq("library_item_id", itemId)
    .eq("uploaded_by", context.user.id)
    .not("unconfirmed_since", "is", null);
  if (staleError) return fail(dbErrorMessage(staleError, "לא הצלחנו להתחיל את ההעלאה. נסו שוב."));
  const { data, error } = await context.supabase
    .from("files")
    .insert({ organization_id: orgId, library_item_id: itemId, name: parsed.data.name, mime_type: parsed.data.type, size_bytes: parsed.data.size })
    .select("id, storage_path")
    .single();
  if (error) return fail(error.code === "42501" ? CANNOT_WRITE : dbErrorMessage(error, "לא הצלחנו להתחיל את ההעלאה."));
  return { ok: true, id: data.id, path: data.storage_path };
}

/** Removes a refused or failed upload: its object (when there is one), then its row. */
async function dropUpload(supabase: Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"], orgId: string, fileId: string): Promise<string | null> {
  const { data: row, error: readError } = await supabase.from("files").select("storage_path").eq("organization_id", orgId).eq("id", fileId).maybeSingle();
  if (readError) return dbErrorMessage(readError);
  if (row) {
    const { error: removeError } = await supabase.storage.from(FILES_BUCKET).remove([row.storage_path]);
    // the object stays; the row below still goes, and the orphan cleanup removes the object at night
    if (removeError) console.error(`[LIB-01] could not remove a refused upload's object: org ${orgId}, file ${fileId}`);
  }
  const { error } = await supabase.from("files").delete().eq("organization_id", orgId).eq("id", fileId);
  return error ? dbErrorMessage(error) : null;
}

/**
 * Step 2: the upload is done (or failed, and the row goes away); the database reads what Storage really holds. Only once the
 * new file is confirmed do the item's earlier files go (rows made before it), so a refused upload never loses the old file,
 * and of two replacements at once the later one stays.
 */
export async function finishLibraryFileAction(orgId: string, fileId: string, uploaded: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, uploaded)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, fileId);
  if (!context.ok) return context;
  if (!uploaded) {
    const problem = await dropUpload(context.supabase, orgId, fileId);
    refresh(orgId);
    return problem ? fail(problem) : ok();
  }
  const { data: verdict, error } = await context.supabase.rpc("confirm_file_upload", { p_org: orgId, p_file: fileId });
  // not answered: the row keeps waiting (shown as unfinished); pg_cron crm-file-confirm checks it within minutes
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לסיים את ההעלאה. נסו שוב."));
  const answer = (verdict ?? {}) as { ok?: boolean; reason?: string };
  if (answer.ok !== true) {
    const problem = await dropUpload(context.supabase, orgId, fileId);
    refresh(orgId);
    return fail(problem ? `${uploadProblemMessage(answer.reason)} ${problem}` : uploadProblemMessage(answer.reason));
  }
  const { data: row, error: rowError } = await context.supabase
    .from("files")
    .select("library_item_id, created_at")
    .eq("organization_id", orgId)
    .eq("id", fileId)
    .maybeSingle();
  if (rowError) return fail(dbErrorMessage(rowError));
  if (row?.library_item_id) {
    const { error: oldError } = await context.supabase
      .from("files")
      .delete()
      .eq("organization_id", orgId)
      .eq("library_item_id", row.library_item_id)
      .is("unconfirmed_since", null)
      .lt("created_at", row.created_at)
      .neq("id", fileId);
    refresh(orgId);
    // the new file is the current one already (the newest confirmed); the earlier one only waits to be removed
    if (oldError) return fail(`הקובץ החדש נשמר, אבל לא הצלחנו להסיר את הקודם. ${dbErrorMessage(oldError)}`);
  }
  refresh(orgId);
  return ok();
}

/** A new category (owners and admins). */
export async function addLibraryCategoryAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = libraryCategorySchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { count, error: countError } = await context.supabase
    .from("library_categories")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (countError) return fail(dbErrorMessage(countError));
  const { error } = await context.supabase
    .from("library_categories")
    .insert({ organization_id: orgId, name: parsed.data.name, position: count ?? 0 })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return fail("כבר יש קטגוריה בשם הזה.", { values: formValues(formData) });
    return fail(error.code === "42501" ? CANNOT_CATEGORIES : dbErrorMessage(error, "לא הצלחנו לשמור את הקטגוריה."), { values: formValues(formData) });
  }
  refresh(orgId);
  return { ok: true, message: "הקטגוריה נוספה." };
}

/** Renames a category. */
export async function renameLibraryCategoryAction(orgId: string, categoryId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, categoryId);
  if (!context.ok) return context;
  const parsed = libraryCategorySchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("library_categories")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", categoryId)
    .select("id");
  if (error) {
    if (error.code === "23505") return fail("כבר יש קטגוריה בשם הזה.", { values: formValues(formData) });
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הקטגוריה."), { values: formValues(formData) });
  }
  if (data.length === 0) return fail(CANNOT_CATEGORIES);
  refresh(orgId);
  return { ok: true, message: "השם נשמר." };
}

/** Deletes a category; its items stay, without a category. */
export async function deleteLibraryCategoryAction(orgId: string, categoryId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, categoryId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("library_categories").delete().eq("organization_id", orgId).eq("id", categoryId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(CANNOT_CATEGORIES);
  refresh(orgId);
  return ok();
}
