"use server";

import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { isMergeType, mergePicks } from "./fields";

const RECORD_PATH = { lead: paths.lead, contact: paths.contact, company: paths.company } as const;

/** Merges the duplicate into the kept record (the database checks who may), then opens the kept record. */
export async function mergeRecordsAction(orgId: string, type: string, keepId: string, mergeId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!isMergeType(type)) return fail("סוג רשומה לא מוכר.");
  const context = await actionContext(orgId, keepId, mergeId);
  if (!context.ok) return context;
  const picks = mergePicks(type, (key) => formData.get(key) === "merge");
  const { error } = await context.supabase.rpc("merge_records", { p_org: orgId, p_type: type, p_keep: keepId, p_merge: mergeId, p_picks: picks });
  if (error) {
    if (error.hint === "merge:both_converted") return fail("שני הלידים כבר הומרו. אפשר למזג את אנשי הקשר שנוצרו מהם.");
    if (error.code === "42501") return fail("אין לכם הרשאה למזג את הרשומות האלה. מיזוג מותר למנהלי צוות ולמנהלי מערכת.");
    return fail(dbErrorMessage(error, "המיזוג נכשל. נסו שוב."));
  }
  redirect(RECORD_PATH[type](orgId, keepId));
}
