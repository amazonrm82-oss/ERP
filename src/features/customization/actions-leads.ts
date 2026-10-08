"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { must } from "@/lib/db-read";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { sourceSchema, statusSchema } from "./schema";

function revalidateLeadSettings(orgId: string) {
  revalidatePath(paths.settingsLeads(orgId));
  revalidatePath(paths.leads(orgId), "layout");
  revalidatePath(paths.org(orgId));
}

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

async function statusesOf(context: Context, orgId: string) {
  const data = must(await context.supabase
    .from("lead_statuses")
    .select("id, kind, position, is_default")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true }), "lead_statuses");
  return data ?? [];
}

async function leadCount(context: Context, orgId: string, statusId: string): Promise<number> {
  const { count } = await context.supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("status_id", statusId);
  return count ?? 0;
}

export async function addStatusAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = statusSchema.safeParse(pick(formData, ["name", "kind"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await statusesOf(context, orgId);
  const { error } = await context.supabase
    .from("lead_statuses")
    .insert({ organization_id: orgId, name: parsed.data.name, kind: parsed.data.kind, position: existing.length });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את הסטטוס. נסו שוב."), { values: formValues(formData) });
  }
  revalidateLeadSettings(orgId);
  return { ok: true };
}

export async function updateStatusAction(orgId: string, statusId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, statusId);
  if (!context.ok) {
    return context;
  }
  const parsed = statusSchema.safeParse(pick(formData, ["name", "kind"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const status = (await statusesOf(context, orgId)).find((s) => s.id === statusId);
  if (!status) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (status.kind !== parsed.data.kind) {
    if (status.is_default) {
      return fail("סטטוס ברירת המחדל חייב להיות מסוג פתוח.", { values: formValues(formData) });
    }
    if ((await leadCount(context, orgId, statusId)) > 0) {
      return fail("אי אפשר לשנות את סוג הסטטוס כשיש לידים בסטטוס הזה.", { values: formValues(formData) });
    }
  }
  const { data, error } = await context.supabase
    .from("lead_statuses")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("id", statusId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLeadSettings(orgId);
  return { ok: true };
}

export async function moveStatusAction(orgId: string, statusId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, statusId);
  if (!context.ok) {
    return context;
  }
  const ordered = await statusesOf(context, orgId);
  const index = ordered.findIndex((s) => s.id === statusId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [position, status] of ordered.entries()) {
    if (status.position !== position) {
      const { error } = await context.supabase.from("lead_statuses").update({ position }).eq("organization_id", orgId).eq("id", status.id);
      if (error) {
        return fail(dbErrorMessage(error));
      }
    }
  }
  revalidateLeadSettings(orgId);
  return ok();
}

/** New leads start in the default status. It must be an open one. */
export async function setDefaultStatusAction(orgId: string, statusId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, statusId);
  if (!context.ok) {
    return context;
  }
  const status = (await statusesOf(context, orgId)).find((s) => s.id === statusId);
  if (!status) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (status.kind !== "open") {
    return fail("רק סטטוס מסוג פתוח יכול להיות ברירת מחדל.");
  }
  // one default per organization (unique index): clear the old one first
  const { error: clearError } = await context.supabase
    .from("lead_statuses")
    .update({ is_default: false })
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .neq("id", statusId);
  if (clearError) {
    return fail(dbErrorMessage(clearError));
  }
  const { data, error } = await context.supabase
    .from("lead_statuses")
    .update({ is_default: true })
    .eq("organization_id", orgId)
    .eq("id", statusId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLeadSettings(orgId);
  return ok();
}

export async function deleteStatusAction(orgId: string, statusId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, statusId);
  if (!context.ok) {
    return context;
  }
  const status = (await statusesOf(context, orgId)).find((s) => s.id === statusId);
  if (!status) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (status.is_default) {
    return fail("אי אפשר למחוק את סטטוס ברירת המחדל. קבעו קודם סטטוס אחר כברירת מחדל.");
  }
  if ((await leadCount(context, orgId, statusId)) > 0) {
    return fail("יש לידים בסטטוס הזה (גם בסל המחזור נספרים). העבירו אותם לסטטוס אחר לפני המחיקה.");
  }
  const { data, error } = await context.supabase.from("lead_statuses").delete().eq("organization_id", orgId).eq("id", statusId).select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLeadSettings(orgId);
  return ok();
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function addSourceAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = sourceSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { error } = await context.supabase.from("lead_sources").insert({ organization_id: orgId, name: parsed.data.name, kind: "other" });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את המקור. נסו שוב."), { values: formValues(formData) });
  }
  revalidateLeadSettings(orgId);
  return { ok: true };
}

export async function renameSourceAction(orgId: string, sourceId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, sourceId);
  if (!context.ok) {
    return context;
  }
  const parsed = sourceSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("lead_sources")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", sourceId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLeadSettings(orgId);
  return { ok: true };
}

/** A hidden source stays on existing records but is no longer offered in forms. */
export async function setSourceActiveAction(orgId: string, sourceId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, sourceId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("lead_sources")
    .update({ is_active: isActive === true })
    .eq("organization_id", orgId)
    .eq("id", sourceId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLeadSettings(orgId);
  return ok();
}
