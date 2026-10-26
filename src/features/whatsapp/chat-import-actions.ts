"use server";

import { revalidatePath } from "next/cache";

import { sanitizeNote } from "@/features/activities/markdown";
import { subjectSchema, type TimelineSubject } from "@/features/activities/schema";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { TIME_ZONE } from "@/lib/app";
import type { Json } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";

import { CHAT_ERRORS, CHAT_MAX_BYTES, chatEntry, parseWhatsappChat } from "./chat-import";
import { plainMentions } from "./templates";

// WAB-07: the record kinds a conversation may be imported to
const IMPORT_KINDS = new Set<TimelineSubject["kind"]>(["lead", "contact", "deal"]);


export type ChatImportSummary = { messages: number; kept: number; truncated: boolean };

/**
 * WAB-07: an exported WhatsApp chat becomes one entry on the record's timeline, through
 * public.whatsapp_chat_import with the user's session (it refuses anyone who may not edit the record). Only
 * the entry's text is kept: the file itself is read here and dropped. The text is stored plain: a mention
 * token in it is flattened (the database refuses one), so an imported chat never notifies a colleague.
 */
export async function importWhatsappChatAction(orgId: string, subject: TimelineSubject, formData: FormData): Promise<ActionResult<ChatImportSummary>> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success || !IMPORT_KINDS.has(parsedSubject.data.kind)) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, parsedSubject.data.id);
  if (!context.ok) {
    return context;
  }
  const file = formData.get("chat");
  if (!(file instanceof Blob) || file.size === 0) {
    return fail(file instanceof Blob ? CHAT_ERRORS.empty : CHAT_ERRORS.no_file);
  }
  if (file.size > CHAT_MAX_BYTES) {
    return fail(CHAT_ERRORS.too_big);
  }
  const text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
  const parsed = parseWhatsappChat(text);
  if (!parsed.ok) {
    return fail(CHAT_ERRORS[parsed.reason]);
  }

  // the export's times are the phone's wall clock: read in the business's time zone
  const { data: org, error: orgError } = await context.supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (orgError) {
    return fail(dbErrorMessage(orgError));
  }
  if (!org) {
    return fail(NOT_FOUND);
  }
  const entry = chatEntry(parsed.chat, org.timezone || TIME_ZONE, new Date());
  const body = plainMentions(sanitizeNote(entry.body));

  // owner, 26 October 2026 (answer (ב)): history, never contact or activity. The database writes it as an import note
  // (GAP-12) after checking that the caller may edit this live record; the author is the caller.
  const { error } = await context.supabase.rpc("whatsapp_chat_import", {
    p_org: orgId,
    p_type: parsedSubject.data.kind,
    p_id: parsedSubject.data.id,
    p_body: body,
    p_occurred_at: entry.occurredAt,
    p_meta: entry.metadata as unknown as Json,
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לייבא את השיחה. נסו שוב."));
  }
  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok({ messages: entry.metadata.message_count, kept: entry.metadata.kept_count, truncated: entry.metadata.truncated });
}
