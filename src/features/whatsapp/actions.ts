"use server";

import { revalidatePath } from "next/cache";

import { sanitizeNote } from "@/features/activities/markdown";
import { subjectSchema, SUBJECT_COLUMN, type TimelineSubject } from "@/features/activities/schema";
import { actionContext } from "@/lib/action-context";
import { directionArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { ActivityInsert } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";
import { pick } from "@/lib/validation";

import { nextPosition, plainMentions } from "./templates";

import { whatsappTemplatesPath } from "./paths";
import { sentMessageSchema, templateSchema, type SentMessage } from "./schema";

// WA-01: owners and admins manage the list; RLS refuses everyone else (0 rows / 42501).

const DUPLICATE_NAME = "כבר יש תבנית בשם הזה.";

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;
export type TemplateChoice = { id: string; name: string; body: string };

async function templatesOf(context: Context, orgId: string) {
  const { data, error } = await context.supabase
    .from("whatsapp_templates")
    .select("id, name, body, position")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return { data: data ?? [], error };
}

/** The templates the record button offers; read when the person opens it. */
export async function loadWhatsappTemplatesAction(orgId: string): Promise<ActionResult<TemplateChoice[]>> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await templatesOf(context, orgId);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לטעון את התבניות."));
  }
  return ok(data.map((row) => ({ id: row.id, name: row.name, body: row.body })));
}

/**
 * The person opened WhatsApp from a record with this text: it goes on the record's timeline
 * as a WhatsApp entry, with the user's session (activities_insert: a writer who can see the
 * record). The entry counts as contact with the customer, like a logged call. The app cannot
 * know whether the message was sent in the end; it logs what the person opened.
 */
export async function logWhatsappMessageAction(orgId: string, subject: TimelineSubject, message: SentMessage): Promise<ActionResult> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND);
  }
  const parsed = sentMessageSchema.safeParse(message);
  if (!parsed.success) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, parsedSubject.data.id, ...(parsed.data.templateId ? [parsed.data.templateId] : []));
  if (!context.ok) {
    return context;
  }

  // the template's current name, read with the user's session (a template deleted meanwhile is simply not named)
  let templateName: string | null = null;
  if (parsed.data.templateId) {
    const { data, error } = await context.supabase
      .from("whatsapp_templates")
      .select("name")
      .eq("organization_id", orgId)
      .eq("id", parsed.data.templateId)
      .maybeSingle();
    if (error) {
      return fail(dbErrorMessage(error));
    }
    templateName = data?.name ?? null;
  }

  // what goes to the customer is plain text: a mention token in it must not notify a colleague
  const body = plainMentions(sanitizeNote(parsed.data.text));
  const activity: ActivityInsert = {
    organization_id: orgId,
    type: "whatsapp",
    body: body === "" ? null : body,
    metadata: { via: "link", ...(templateName ? { template_id: parsed.data.templateId, template_name: templateName } : {}) },
  };
  activity[SUBJECT_COLUMN[parsedSubject.data.kind]] = parsedSubject.data.id;
  const { error } = await context.supabase.from("activities").insert(activity);
  if (error) {
    return fail(dbErrorMessage(error, "ההודעה נפתחה ב-WhatsApp, אבל לא הצלחנו לרשום אותה בציר הזמן."));
  }
  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok();
}

export async function addTemplateAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = templateSchema.safeParse(pick(formData, ["name", "body"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await templatesOf(context, orgId);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  }
  const { error } = await context.supabase
    .from("whatsapp_templates")
    .insert({ organization_id: orgId, name: parsed.data.name, body: parsed.data.body, position: nextPosition(existing.data) });
  if (error) {
    return fail(error.code === "23505" ? DUPLICATE_NAME : dbErrorMessage(error, "לא הצלחנו להוסיף את התבנית. נסו שוב."), {
      values: formValues(formData),
    });
  }
  revalidatePath(whatsappTemplatesPath(orgId));
  return ok();
}

export async function updateTemplateAction(orgId: string, templateId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) {
    return context;
  }
  const parsed = templateSchema.safeParse(pick(formData, ["name", "body"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("whatsapp_templates")
    .update({ name: parsed.data.name, body: parsed.data.body })
    .eq("organization_id", orgId)
    .eq("id", templateId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? DUPLICATE_NAME : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(whatsappTemplatesPath(orgId));
  return { ok: true, message: "התבנית נשמרה." };
}

export async function moveTemplateAction(orgId: string, templateId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, templateId);
  if (!context.ok) {
    return context;
  }
  const { data: ordered, error: readError } = await templatesOf(context, orgId);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const index = ordered.findIndex((template) => template.id === templateId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [position, template] of ordered.entries()) {
    if (template.position !== position) {
      const { data, error } = await context.supabase
        .from("whatsapp_templates")
        .update({ position })
        .eq("organization_id", orgId)
        .eq("id", template.id)
        .select("id");
      if (error) {
        return fail(dbErrorMessage(error));
      }
      if (data.length === 0) {
        return fail(NOT_FOUND_OR_FORBIDDEN);
      }
    }
  }
  revalidatePath(whatsappTemplatesPath(orgId));
  return ok();
}

/** Messages already logged keep their text; only the template goes. */
export async function deleteTemplateAction(orgId: string, templateId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("whatsapp_templates").delete().eq("organization_id", orgId).eq("id", templateId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(whatsappTemplatesPath(orgId));
  return ok();
}
