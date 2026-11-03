"use server";

import { revalidatePath } from "next/cache";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { pickerQuery } from "@/components/ui/search-picker-logic";
import { isGender, type Gender } from "@/features/gender/gender";
import { getOrgModules } from "@/features/modules/queries";
import { shareSearchHits, subjectFromPick, type SearchRecordsAnswer } from "@/features/share/records";
import { getOrgTerms } from "@/features/terminology/queries";
import { firstNameOf } from "@/features/whatsapp/templates";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { messageTemplatesPath } from "./paths";
import { messageTemplateSchema, type MessageTemplateInput } from "./schema";
import { templateProblemText } from "./service-rule";

// MSG-02: owners and admins of a writable business manage the list; RLS refuses everyone else (0 rows / 42501).

const DUPLICATE_NAME = "כבר יש תבנית בשם הזה.";
const FIELDS = ["name", "channel", "message_type", "subject", "body", "locale", "is_active"] as const;

/** Owner (90) ג: a service template that will not be sent is still saved; the answer says why (null when it may be sent). */
function sendProblem(input: MessageTemplateInput): string | null {
  return templateProblemText({ channel: input.channel, messageType: input.message_type, subject: input.subject, body: input.body });
}

function parse(formData: FormData) {
  return messageTemplateSchema.safeParse(pick(formData, [...FIELDS]));
}

export async function addMessageTemplateAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = parse(formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const { error } = await context.supabase.from("message_templates").insert({ organization_id: orgId, ...parsed.data });
  if (error) {
    return fail(error.code === "23505" ? DUPLICATE_NAME : dbErrorMessage(error, "לא הצלחנו להוסיף את התבנית. נסו שוב."), {
      values: formValues(formData),
    });
  }
  revalidatePath(messageTemplatesPath(orgId));
  const problem = sendProblem(parsed.data);
  return problem ? { ok: true, message: `התבנית נשמרה. ${problem}` } : ok();
}

export async function updateMessageTemplateAction(orgId: string, templateId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const parsed = parse(formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("message_templates")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("id", templateId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? DUPLICATE_NAME : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(messageTemplatesPath(orgId));
  const problem = sendProblem(parsed.data);
  return { ok: true, message: problem ? `התבנית נשמרה. ${problem}` : "התבנית נשמרה." };
}

export async function deleteMessageTemplateAction(orgId: string, templateId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("message_templates").delete().eq("organization_id", orgId).eq("id", templateId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(messageTemplatesPath(orgId));
  return ok();
}

const SEARCH_FAILED = "החיפוש נכשל. נסו שוב.";

/**
 * The record picker of the preview: the global search (public.search_records, security invoker: RLS decides what is
 * found) with the user's session, leads and contacts only (messages go to them), a switched-off module left out.
 */
export async function searchPreviewRecordsAction(orgId: string, query: string): Promise<SearchPickerResult> {
  if (!validArg(optionalTextArg(100), query) || typeof query !== "string") return { hits: [] };
  const term = pickerQuery(query);
  if (term === null) return { hits: [] };
  const context = await actionContext(orgId);
  if (!context.ok) return { error: context.message };
  const { data, error } = await context.supabase.rpc("search_records", {
    p_org: orgId,
    p_query: term,
    p_limit: 6,
  });
  if (error) return { error: SEARCH_FAILED };
  const [modules, terms] = await Promise.all([getOrgModules(orgId), getOrgTerms(orgId)]);
  const hits = shareSearchHits(data as SearchRecordsAnswer, modules, terms).filter(
    (hit) => hit.id.startsWith("lead:") || hit.id.startsWith("contact:"),
  );
  return { hits };
}

export type PreviewPerson = {
  firstName: string | null;
  fullName: string | null;
  gender: Gender | null;
};

/** The picked record's names and gender for the preview, read with the user's session (a record the user cannot read is not found). */
export async function previewPersonAction(orgId: string, picked: string): Promise<ActionResult<PreviewPerson>> {
  const subject = subjectFromPick(picked);
  if (!subject || (subject.kind !== "lead" && subject.kind !== "contact")) return fail(NOT_FOUND);
  const context = await actionContext(orgId, subject.id);
  if (!context.ok) return context;
  if (subject.kind === "lead") {
    const { data, error } = await context.supabase
      .from("leads")
      .select("full_name, gender")
      .eq("organization_id", orgId)
      .eq("id", subject.id)
      .maybeSingle();
    if (error) return fail(dbErrorMessage(error));
    if (!data) return fail(NOT_FOUND);
    return ok({
      firstName: firstNameOf(data.full_name),
      fullName: data.full_name,
      gender: isGender(data.gender) ? data.gender : null,
    });
  }
  const { data, error } = await context.supabase
    .from("contacts")
    .select("first_name, full_name, gender")
    .eq("organization_id", orgId)
    .eq("id", subject.id)
    .maybeSingle();
  if (error) return fail(dbErrorMessage(error));
  if (!data) return fail(NOT_FOUND);
  return ok({
    firstName: data.first_name?.trim() || firstNameOf(data.full_name),
    fullName: data.full_name,
    gender: isGender(data.gender) ? data.gender : null,
  });
}
