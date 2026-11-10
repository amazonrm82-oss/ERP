"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";

import { queuedMessage, RECORD_EMAIL_KINDS, RECORD_EMAIL_MAX_FILES } from "./logic";

const filesArg = z.array(z.string().uuid()).max(RECORD_EMAIL_MAX_FILES * 2);

/**
 * EML-02: queues the email with the user's session through public.record_email_send, which reads the record, the
 * template, the record's files and the library items with the user's rights and judges everything again (hard rule: no service key). The message
 * itself is judged by the queue's send check (consent, blocklist, pause, hours, caps) when it is its turn.
 */
export async function sendRecordEmailAction(
  orgId: string,
  kind: string,
  recordId: string,
  templateId: string,
  fileIds: string[],
  libraryItemIds: string[] = [],
): Promise<ActionResult> {
  if (!validArg(z.enum(RECORD_EMAIL_KINDS), kind) || !validArg(filesArg, fileIds) || !validArg(filesArg, libraryItemIds)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, recordId, templateId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.rpc("record_email_send", {
    p_org: orgId,
    p_kind: kind,
    p_record: recordId,
    p_template: templateId,
    p_files: [...new Set(fileIds)],
    p_library_items: [...new Set(libraryItemIds)],
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשלוח את האימייל. נסו שוב."));
  }
  const paused = Boolean(data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).paused === true);
  revalidatePath(recordPage(kind, orgId, recordId));
  return { ok: true, message: queuedMessage(paused) };
}
