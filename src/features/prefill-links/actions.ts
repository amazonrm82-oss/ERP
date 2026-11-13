"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

import { checkPrefillFields, isPrefillRecordType, PREFILL_MAX_FIELDS, type PrefillRecordType } from "./fields";
import { prefillFormsSettingsPath, publicPrefillPath } from "./paths";
import { PREFILL_LINK_TOKEN } from "./public";

// BIZ-05: templates (owners/admins, RLS decides) and personal links (public.prefill_link_create / _revoke), with the user's
// session. The database keeps only the token's hash; the address is answered once.

const CANNOT_SEND = "אין לכם הרשאה לשלוח טופס לרשומה הזאת.";
const CANNOT_EDIT = "את הטפסים מגדירים בעלי העסק ומנהלי המערכת.";
const linkError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT_SEND : dbErrorMessage(error));

const FIELD_MESSAGES = {
  empty: "בחרו לפחות שדה אחד.",
  many: `אפשר לבחור עד ${PREFILL_MAX_FIELDS} שדות.`,
  field: "אחד השדות אינו זמין בטופס כזה, או שנבחר פעמיים.",
  sensitive: "שדה שסומן כמידע רגיש לא נכנס לטופס השלמת פרטים.",
} as const;

const templateSchema = z.object({
  name: z.string().trim().min(1, "כתבו שם לטופס.").max(80, "השם ארוך מדי (עד 80 תווים)."),
  title: z.string().trim().min(1, "כתבו כותרת שהלקוח יראה.").max(120, "הכותרת ארוכה מדי (עד 120 תווים)."),
  intro: z.string().trim().max(500, "הפתיח ארוך מדי (עד 500 תווים)."),
  fields: z.array(z.string().max(43)).max(40),
  isActive: z.boolean(),
});

export type PrefillTemplateInput = z.infer<typeof templateSchema>;

function recordPath(orgId: string, recordType: PrefillRecordType, id: string): string {
  return recordType === "lead" ? paths.lead(orgId, id) : paths.contact(orgId, id);
}

async function fieldsProblem(orgId: string, recordType: PrefillRecordType, keys: string[]): Promise<string | null> {
  const definitions = await listFieldDefinitions(orgId, recordType);
  const problem = checkPrefillFields(recordType, keys, definitions);
  return problem ? FIELD_MESSAGES[problem] : null;
}

/** A new template. */
export async function createPrefillFormAction(orgId: string, recordType: string, input: PrefillTemplateInput): Promise<ActionResult> {
  if (!isPrefillRecordType(recordType)) return fail(INVALID_ARGS);
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? INVALID_ARGS);
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const problem = await fieldsProblem(orgId, recordType, parsed.data.fields);
  if (problem) return fail(problem);
  const { error } = await context.supabase.from("prefill_forms").insert({
    organization_id: orgId,
    record_type: recordType,
    name: parsed.data.name,
    title: parsed.data.title,
    intro: parsed.data.intro || null,
    fields: parsed.data.fields,
    is_active: parsed.data.isActive,
  });
  if (error) return fail(error.code === "42501" ? CANNOT_EDIT : dbErrorMessage(error));
  revalidatePath(prefillFormsSettingsPath(orgId));
  return ok();
}

/** Saves a template (its record type never changes). */
export async function updatePrefillFormAction(orgId: string, formId: string, input: PrefillTemplateInput): Promise<ActionResult> {
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? INVALID_ARGS);
  const context = await actionContext(orgId, formId);
  if (!context.ok) return context;
  const { data: current, error: readError } = await context.supabase
    .from("prefill_forms")
    .select("record_type")
    .eq("organization_id", orgId)
    .eq("id", formId)
    .maybeSingle();
  if (readError) return fail(dbErrorMessage(readError));
  if (!current || !isPrefillRecordType(current.record_type)) return fail("הטופס לא נמצא.");
  const problem = await fieldsProblem(orgId, current.record_type, parsed.data.fields);
  if (problem) return fail(problem);
  const { data, error } = await context.supabase
    .from("prefill_forms")
    .update({ name: parsed.data.name, title: parsed.data.title, intro: parsed.data.intro || null, fields: parsed.data.fields, is_active: parsed.data.isActive })
    .eq("organization_id", orgId)
    .eq("id", formId)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (!data || data.length === 0) return fail(CANNOT_EDIT);
  revalidatePath(prefillFormsSettingsPath(orgId));
  return ok();
}

/** Removes a template; its links stop working (they go with it). */
export async function deletePrefillFormAction(orgId: string, formId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, formId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("prefill_forms").delete().eq("organization_id", orgId).eq("id", formId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (!data || data.length === 0) return fail(CANNOT_EDIT);
  revalidatePath(prefillFormsSettingsPath(orgId));
  return ok();
}

/** A new personal link of one template for the record. The address is returned once. */
export async function createPrefillLinkAction(orgId: string, recordType: string, recordId: string, formId: string): Promise<ActionResult<{ url: string }>> {
  if (!isPrefillRecordType(recordType)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, recordId, formId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("prefill_link_create", {
    p_org: orgId,
    p_form: formId,
    p_record_type: recordType,
    p_record_id: recordId,
  });
  if (error) return fail(linkError(error));
  if (typeof data !== "string" || !PREFILL_LINK_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  revalidatePath(recordPath(orgId, recordType, recordId));
  return ok({ url: `${await siteOrigin()}${publicPrefillPath(data)}` });
}

/** Turns one link off; its page answers "not found" from now on. */
export async function revokePrefillLinkAction(orgId: string, recordType: string, recordId: string, linkId: string): Promise<ActionResult> {
  if (!isPrefillRecordType(recordType)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, recordId, linkId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("prefill_link_revoke", { p_org: orgId, p_link: linkId });
  if (error) return fail(linkError(error));
  revalidatePath(recordPath(orgId, recordType, recordId));
  return ok();
}
