"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { addRelationSchema, LEAD_REFERRAL_FIELD_NAMES, leadReferralSchema, RELATION_FIELD_NAMES, relationTypeSchema } from "./schema";
import { REFERRAL_TYPE_KEY } from "./types";

const CANNOT_RELATE =
  "אי אפשר לשמור את הקשר. ייתכן שאחד מאנשי הקשר בסל המחזור, שאין לכם גישה אליו, או שאין לכם הרשאה לערוך אף אחד מהם.";
const TYPE_IN_USE = "סוג הקשר הזה רשום אצל אנשי קשר, ולכן אי אפשר למחוק אותו. אפשר להסתיר אותו במקום.";
const TYPE_EXISTS = "יש כבר סוג קשר בשם הזה.";

function revalidateContacts(orgId: string, ...contactIds: string[]) {
  for (const id of contactIds) revalidatePath(paths.contact(orgId, id));
}

/** CON-06: a relation between this contact and another one. Rights: edit one of the two and read the other (RLS). */
export async function addContactRelationAction(orgId: string, contactId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, contactId);
  if (!context.ok) {
    return context;
  }
  const parsed = addRelationSchema.safeParse(pick(formData, RELATION_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { choice, other_id: otherId } = parsed.data;
  if (otherId === contactId) {
    return fail("קשר הוא בין שני אנשי קשר שונים.", { values: formValues(formData) });
  }
  // this contact's side: "out" = this contact is the first ("A <name> B")
  const [first, second] = choice.side === "out" ? [contactId, otherId] : [otherId, contactId];
  const { error } = await context.supabase
    .from("contact_relations")
    .insert({ organization_id: orgId, contact_id: first, related_contact_id: second, type_id: choice.typeId });
  if (error) {
    const message = error.code === "42501" || error.code === "23503" ? CANNOT_RELATE : dbErrorMessage(error);
    return fail(message, { values: formValues(formData) });
  }
  revalidateContacts(orgId, contactId, otherId);
  return ok();
}

/** CON-06: remove a relation shown on this contact's card. Both people stay. */
export async function removeContactRelationAction(orgId: string, contactId: string, relationId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, contactId, relationId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("contact_relations")
    .delete()
    .eq("organization_id", orgId)
    .eq("id", relationId)
    .or(`contact_id.eq.${contactId},related_contact_id.eq.${contactId}`)
    .select("contact_id, lead_id, related_contact_id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateRelation(orgId, data[0]);
  return ok();
}

function revalidateRelation(orgId: string, row: { contact_id: string | null; lead_id: string | null; related_contact_id: string }) {
  revalidateContacts(orgId, row.related_contact_id, ...(row.contact_id ? [row.contact_id] : []));
  if (row.lead_id) revalidatePath(paths.lead(orgId, row.lead_id));
}

const CANNOT_REFER =
  "אי אפשר לשמור את ההפניה. ייתכן שהליד הומר או בסל המחזור, שאיש הקשר בסל המחזור או שאין לכם גישה אליו, או שאין לכם הרשאה לערוך אף אחד מהם.";

/** CON-06: a contact this lead referred (the business's referral type). Rights: edit one of the two and read the other (RLS). */
export async function addLeadReferralAction(orgId: string, leadId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, leadId);
  if (!context.ok) {
    return context;
  }
  const parsed = leadReferralSchema.safeParse(pick(formData, LEAD_REFERRAL_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data: type, error: typeError } = await context.supabase
    .from("contact_relation_types")
    .select("id")
    .eq("organization_id", orgId)
    .eq("key", REFERRAL_TYPE_KEY)
    .eq("is_active", true)
    .maybeSingle();
  if (typeError) {
    return fail(dbErrorMessage(typeError), { values: formValues(formData) });
  }
  if (!type) {
    return fail("סוג הקשר של הפניות לא פעיל ברשימה של העסק.", { values: formValues(formData) });
  }
  const { error } = await context.supabase
    .from("contact_relations")
    .insert({ organization_id: orgId, lead_id: leadId, related_contact_id: parsed.data.other_id, type_id: type.id });
  if (error) {
    const message = error.code === "42501" || error.code === "23503" ? CANNOT_REFER : dbErrorMessage(error);
    return fail(message, { values: formValues(formData) });
  }
  revalidatePath(paths.lead(orgId, leadId));
  revalidateContacts(orgId, parsed.data.other_id);
  return ok();
}

/** CON-06: remove a referral shown on this lead's card. Both stay. */
export async function removeLeadReferralAction(orgId: string, leadId: string, relationId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, leadId, relationId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("contact_relations")
    .delete()
    .eq("organization_id", orgId)
    .eq("id", relationId)
    .eq("lead_id", leadId)
    .select("contact_id, lead_id, related_contact_id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateRelation(orgId, data[0]);
  return ok();
}

// ----------------------------------------------------------------------------
// The business's list of types: owners and admins (RLS refuses everyone else)
// ----------------------------------------------------------------------------

function revalidateTypes(orgId: string) {
  revalidatePath(paths.settingsContactRelationTypes(orgId));
  revalidatePath(paths.contacts(orgId), "layout");
}

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

async function typesOf(context: Context, orgId: string) {
  const { data, error } = await context.supabase
    .from("contact_relation_types")
    .select("id, position")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return { data: data ?? [], error };
}

export async function addRelationTypeAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = relationTypeSchema.safeParse(pick(formData, ["name", "reverse_name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await typesOf(context, orgId);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  }
  const { error } = await context.supabase
    .from("contact_relation_types")
    .insert({ organization_id: orgId, name: parsed.data.name, reverse_name: parsed.data.reverse_name, position: existing.data.length });
  if (error) {
    return fail(error.code === "23505" ? TYPE_EXISTS : dbErrorMessage(error, "לא הצלחנו להוסיף את סוג הקשר. נסו שוב."), { values: formValues(formData) });
  }
  revalidateTypes(orgId);
  return ok();
}

export async function updateRelationTypeAction(orgId: string, typeId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const parsed = relationTypeSchema.safeParse(pick(formData, ["name", "reverse_name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("contact_relation_types")
    .update({ name: parsed.data.name, reverse_name: parsed.data.reverse_name })
    .eq("organization_id", orgId)
    .eq("id", typeId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? TYPE_EXISTS : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTypes(orgId);
  return ok();
}

/** A hidden type stays on the relations that have it, but is no longer offered. */
export async function setRelationTypeActiveAction(orgId: string, typeId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("contact_relation_types")
    .update({ is_active: isActive === true })
    .eq("organization_id", orgId)
    .eq("id", typeId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTypes(orgId);
  return ok();
}

export async function moveRelationTypeAction(orgId: string, typeId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data: ordered, error: readError } = await typesOf(context, orgId);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const index = ordered.findIndex((type) => type.id === typeId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [position, type] of ordered.entries()) {
    if (type.position !== position) {
      const { data, error } = await context.supabase
        .from("contact_relation_types")
        .update({ position })
        .eq("organization_id", orgId)
        .eq("id", type.id)
        .select("id");
      if (error) {
        return fail(dbErrorMessage(error));
      }
      if (data.length === 0) {
        return fail(NOT_FOUND_OR_FORBIDDEN);
      }
    }
  }
  revalidateTypes(orgId);
  return ok();
}

/** A type no relation uses is deleted; one in use is refused by the database (it can be hidden instead). */
export async function deleteRelationTypeAction(orgId: string, typeId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("contact_relation_types").delete().eq("organization_id", orgId).eq("id", typeId).select("id");
  if (error) {
    return fail(error.code === "23503" ? TYPE_IN_USE : dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTypes(orgId);
  return ok();
}
