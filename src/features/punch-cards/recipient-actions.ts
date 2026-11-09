"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { parseRelationChoice } from "@/features/contact-relations/types";
import { duplicateMessage, findPersonDuplicate } from "@/features/data-quality/duplicates";
import { orderPath } from "@/features/orders/paths";
import { quotePath } from "@/features/quotes/paths";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { optionalEmail, optionalId, optionalPhone, optionalText, requiredText } from "@/lib/validation";

import type { RecipientDocKind } from "./recipients";

// PKG-06: the service recipient of a draft's punch card line, written with the user's session. RLS (a draft the person
// edits) and the line trigger (app.document_line_recipient: a punch card line, a contact the person reads, linked to the
// payer) decide; a refused write answers the trigger's hint in Hebrew.

const kindArg = z.enum(["quote", "order"]);
const contactArg = z.guid().nullable();

function revalidateDoc(orgId: string, kind: RecipientDocKind, docId: string) {
  revalidatePath(kind === "quote" ? quotePath(orgId, docId) : orderPath(orgId, docId));
}

type Client = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

async function writeRecipient(supabase: Client, orgId: string, kind: RecipientDocKind, docId: string, lineId: string, contactId: string | null) {
  const query =
    kind === "quote"
      ? supabase.from("quote_lines").update({ recipient_contact_id: contactId }).eq("organization_id", orgId).eq("quote_id", docId).eq("id", lineId).select("id")
      : supabase.from("order_lines").update({ recipient_contact_id: contactId }).eq("organization_id", orgId).eq("order_id", docId).eq("id", lineId).select("id");
  const { data, error } = await query;
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  return ok();
}

/** Pick the recipient of a line from the offered contacts (null = the payer). */
export async function setLineRecipientAction(orgId: string, kind: unknown, docId: string, lineId: string, contactId: unknown): Promise<ActionResult> {
  if (!validArg(kindArg, kind) || !validArg(contactArg, contactId)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, docId, lineId);
  if (!context.ok) return context;
  const result = await writeRecipient(context.supabase, orgId, kind, docId, lineId, contactId);
  if (result.ok) revalidateDoc(orgId, kind, docId);
  return result;
}

const addSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), contact_id: optionalId.refine((v) => v !== null, { error: "יש לבחור איש קשר." }), choice: z.string().optional() }),
  z.object({
    mode: z.literal("new"),
    first_name: requiredText(100, "יש להזין שם פרטי.", "השם ארוך מדי."),
    last_name: optionalText(100, "השם ארוך מדי."),
    phone: optionalPhone,
    email: optionalEmail,
    choice: z.string().optional(),
  }),
]);

const ADD_FIELDS = ["mode", "contact_id", "choice", "first_name", "last_name", "phone", "email"] as const;

/**
 * (150) ג: a recipient added from the line without leaving the document: an existing contact, or a new one (after the
 * DQL-02 duplicate check), linked to the payer (a contact: a CON-06 relation of the kind chosen; a company: an employee,
 * the company is the new contact's own, or a CON-05 link of an existing one), then set on the line.
 */
export async function addLineRecipientAction(
  orgId: string,
  kind: unknown,
  docId: string,
  lineId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!validArg(kindArg, kind)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, docId, lineId);
  if (!context.ok) return context;
  const values: Record<string, unknown> = {};
  for (const key of ADD_FIELDS) values[key] = formData.get(key) ?? undefined;
  const parsed = addSchema.safeParse(values);
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;

  // the payer, read with the user's session (the draft the person edits)
  const docRead =
    kind === "quote"
      ? await context.supabase.from("quotes").select("contact_id, company_id, status").eq("organization_id", orgId).eq("id", docId).maybeSingle()
      : await context.supabase.from("orders").select("contact_id, company_id, status").eq("organization_id", orgId).eq("id", docId).maybeSingle();
  if (docRead.error) return fail(dbErrorMessage(docRead.error), { values: formValues(formData) });
  const doc = docRead.data;
  if (!doc || doc.status !== "draft") return fail(NOT_FOUND_OR_FORBIDDEN);
  const payerContact = doc.contact_id;
  const payerCompany = doc.company_id;
  if (!payerContact && !payerCompany) {
    return fail("למסמך הזה אין עדיין לקוח. בחרו לקוח במסמך, ואז את מקבל השירות.", { values: formValues(formData) });
  }
  const relation = payerContact ? parseRelationChoice(input.choice) : null;
  if (payerContact && !relation) {
    return fail("יש לבחור את הקשר למשלם.", { fieldErrors: { choice: "יש לבחור את הקשר למשלם." }, values: formValues(formData) });
  }

  let recipientId: string;
  if (input.mode === "existing") {
    recipientId = input.contact_id as string;
  } else {
    if (formData.get("allow_duplicate") !== "on") {
      const duplicate = await findPersonDuplicate(context.supabase, orgId, [input.phone], [input.email]);
      if (duplicate) {
        // the person may still create the new contact (the box), or pick the existing one instead
        return fail(duplicateMessage(duplicate, "הטלפון או האימייל האלה"), {
          fieldErrors: { allow_duplicate: duplicate.href },
          values: formValues(formData),
        });
      }
    }
    // owner_id is left out: the database gives the contact to its creator; an employee of the paying company has it
    const { data, error } = await context.supabase
      .from("contacts")
      .insert({
        organization_id: orgId,
        first_name: input.first_name,
        last_name: input.last_name,
        phone: input.phone,
        email: input.email,
        company_id: payerContact ? null : payerCompany,
      })
      .select("id")
      .single();
    if (error) return fail(dbErrorMessage(error, "לא הצלחנו ליצור את איש הקשר. נסו שוב."), { values: formValues(formData) });
    recipientId = data.id as string;
  }

  // the link to the payer (none needed when the payer itself is picked)
  if (recipientId === payerContact) {
    // nothing to link
  } else if (payerContact && relation) {
    const [first, second] = relation.side === "out" ? [recipientId, payerContact] : [payerContact, recipientId];
    const { error } = await context.supabase
      .from("contact_relations")
      .insert({ organization_id: orgId, contact_id: first, related_contact_id: second, type_id: relation.typeId });
    if (error && error.hint !== "contact_relation:exists" && error.code !== "23505") {
      return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הקשר למשלם."), { values: formValues(formData) });
    }
  } else if (payerCompany && input.mode === "existing") {
    const { error } = await context.supabase.from("contact_companies").insert({ organization_id: orgId, contact_id: recipientId, company_id: payerCompany });
    if (error && error.code !== "23505") {
      return fail(dbErrorMessage(error, "לא הצלחנו לקשר את איש הקשר לחברה."), { values: formValues(formData) });
    }
  }
  const result = await writeRecipient(context.supabase, orgId, kind, docId, lineId, recipientId);
  if (!result.ok) return { ...result, values: formValues(formData) };
  revalidateDoc(orgId, kind, docId);
  return ok();
}
