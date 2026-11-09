"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { MAX_IMPORT_ROWS } from "@/features/imports/fields";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { BACKGROUND_BUSY, BACKGROUND_IMPORT_MODES, BACKGROUND_MODE_ONLY, BACKGROUND_NO_FILE, BACKGROUND_STATE, sourcePath } from "./rules";
import { backgroundJobsReady } from "./user-token";

const NOT_SET_UP = "עבודות ברקע עוד לא מוגדרות במערכת. אפשר לייבא ולייצא כרגיל מהדפדפן.";
const IMPORT_FORBIDDEN = "ייבוא מותר לבעלים, למנהלי מערכת ולמנהלי צוות.";
const EXPORT_FORBIDDEN = "ייצוא מלא זמין לבעלים של העסק בלבד.";

function orderError(error: { code?: string; hint?: string | null }, forbidden: string): string {
  if (error.hint === "background:busy") return BACKGROUND_BUSY;
  if (error.code === "42501") return forbidden;
  return dbErrorMessage(error, "לא הצלחנו להזמין את העבודה. נסו שוב.");
}

/**
 * IMP-04: orders a background import with the user's own session (the database checks app.can_import). The browser
 * then uploads the parsed rows to the answered path and submits.
 */
export async function orderBackgroundImportAction(
  orgId: string,
  input: { entity: string; mode: string; fileName: string; totalRows: number },
): Promise<ActionResult<{ requestId: string; path: string }>> {
  if (
    !validArg(
      z.object({
        entity: z.enum(["lead", "contact", "company", "product", "deal", "task"]),
        mode: z.string().max(20),
        fileName: z.string().max(2000),
        totalRows: z.number().int().min(1).max(MAX_IMPORT_ROWS),
      }),
      input,
    )
  ) {
    return fail(INVALID_ARGS);
  }
  // owner (163) ב: only "skip" or "update" (the database refuses any other rule too)
  if (!(BACKGROUND_IMPORT_MODES as readonly string[]).includes(input.mode)) return fail(BACKGROUND_MODE_ONLY);
  if (!backgroundJobsReady()) return fail(NOT_SET_UP);
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("background_requests")
    .insert({
      organization_id: orgId,
      kind: "import",
      entity_type: input.entity,
      duplicate_mode: input.mode,
      file_name: (input.fileName || "file").slice(0, 255),
      total_rows: input.totalRows,
    })
    .select("id")
    .single();
  if (error) return fail(orderError(error, IMPORT_FORBIDDEN));
  return ok({ requestId: data.id, path: sourcePath(orgId, data.id) });
}

/** The file arrived: the import goes to the queue. */
export async function submitBackgroundImportAction(orgId: string, requestId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, requestId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("background_request_submit", { p_org: orgId, p_request: requestId });
  if (error) {
    if (error.hint === "background:no_file") return fail(BACKGROUND_NO_FILE);
    if (error.hint === "background:state") return fail(BACKGROUND_STATE);
    return fail(error.code === "42501" ? IMPORT_FORBIDDEN : dbErrorMessage(error, "לא הצלחנו לשלוח את הייבוא לרקע. נסו שוב."));
  }
  revalidatePath(paths.imports(orgId));
  return ok();
}

/** IMP-04: the full export in the background (the owner; the database checks it again when the job runs). */
export async function orderFullExportAction(orgId: string): Promise<ActionResult> {
  if (!backgroundJobsReady()) return fail(NOT_SET_UP);
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { error } = await context.supabase.from("background_requests").insert({ organization_id: orgId, kind: "export" }).select("id").single();
  if (error) return fail(orderError(error, EXPORT_FORBIDDEN));
  revalidatePath(paths.imports(orgId));
  return { ok: true, message: "הייצוא יוכן ברקע. נודיע לכם כשהקובץ מוכן להורדה." };
}

/** Cancels the person's own order that has not ended (a running import stops after the chunk it is on). */
export async function cancelBackgroundRequestAction(orgId: string, requestId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, requestId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("background_request_cancel", { p_org: orgId, p_request: requestId });
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לבטל. נסו שוב."));
  if (!data) return fail("העבודה כבר הסתיימה.");
  revalidatePath(paths.imports(orgId));
  return ok();
}
