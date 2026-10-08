"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { setLeadStatus } from "@/features/leads/status";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import type { Database } from "@/lib/database.types";
import { isUuid, paths } from "@/lib/paths";

// What can be edited in a list's cell (LST-06), per list. The database decides
// who may: the update runs with the user's session, and 0 rows means "not allowed".
export type InlineObject = "lead" | "contact" | "company";
export type InlineField = "name" | "status" | "owner";
export type InlineValue = { text?: string; first?: string; last?: string; id?: string | null; reason?: string };

const ALLOWED: Record<InlineObject, InlineField[]> = { lead: ["name", "status", "owner"], contact: ["name", "owner"], company: ["name", "owner"] };
const TABLE = { lead: "leads", contact: "contacts", company: "companies" } as const;
const LIST = { lead: paths.leads, contact: paths.contacts, company: paths.companies } as const;
const RECORD = { lead: paths.lead, contact: paths.contact, company: paths.company } as const;

const text = (max: number) => z.string().trim().max(max, { error: "הטקסט ארוך מדי." });

export async function inlineEditAction(orgId: string, object: InlineObject, id: string, field: InlineField, value: InlineValue): Promise<ActionResult> {
  if (!(object in TABLE) || !ALLOWED[object].includes(field)) {
    return fail("אי אפשר לערוך את השדה הזה מהרשימה.");
  }
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }

  // the columns differ per table, so the patch is typed loosely and the table name picks the shape
  let patch: { owner_id?: string | null; first_name?: string | null; last_name?: string | null; name?: string; full_name?: string | null };
  if (field === "status") {
    if (!isUuid(value.id ?? "")) return fail("יש לבחור סטטוס.");
    const result = await setLeadStatus(context.supabase, orgId, id, value.id!, value.reason?.trim().slice(0, 500) || null);
    if (!result.ok) return fail(result.message);
    revalidatePath(LIST[object](orgId));
    revalidatePath(RECORD[object](orgId, id));
    return ok();
  } else if (field === "owner") {
    const owner = value.id ?? null;
    if (owner !== null && !isUuid(owner)) return fail("יש לבחור בעלים.");
    patch = { owner_id: owner };
  } else if (object === "contact") {
    const first = text(100).safeParse(value.first ?? "");
    const last = text(100).safeParse(value.last ?? "");
    if (!first.success || !last.success) return fail("הטקסט ארוך מדי.");
    if (!first.data && !last.data) return fail("יש לכתוב שם פרטי או שם משפחה.");
    patch = { first_name: first.data || null, last_name: last.data || null };
  } else {
    const name = text(200).safeParse(value.text ?? "");
    if (!name.success) return fail(name.error.issues[0]?.message ?? "השם אינו תקין.");
    if (object === "company" && !name.data) return fail("יש לכתוב שם לחברה.");
    // a lead may have no name when it has a phone or an email (the database checks)
    patch = object === "company" ? { name: name.data } : { full_name: name.data || null };
  }

  const { data, error } = await context.supabase
    .from(TABLE[object] as "contacts")
    .update(patch as Database["public"]["Tables"]["contacts"]["Update"])
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    if (error.code === "23514") return fail("צריך להשאיר לליד שם, טלפון או אימייל.");
    // the new owner is outside what the user may manage (a manager hands a record out of their teams)
    if (error.code === "42501" && field === "owner") return fail("אין לכם הרשאה להעביר את הרשומה לבעלים הזה.");
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(LIST[object](orgId));
  revalidatePath(RECORD[object](orgId, id));
  return ok();
}
