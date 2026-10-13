"use server";

import { revalidatePath } from "next/cache";

import { SUBJECT_COLUMN, subjectSchema, type TimelineSubject } from "@/features/activities/schema";
import { actionContext } from "@/lib/action-context";
import { booleanArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

const RECORD_PATH = {
  lead: paths.lead,
  contact: paths.contact,
  company: paths.company,
  deal: paths.deal,
} as const;

const CANNOT_FOLLOW = "אי אפשר לעקוב אחרי הרשומה. ייתכן שנמחקה או שאין לכם הרשאה לראות אותה.";

/** REC-03: start or stop following a record, for the signed-in user only (the database sets user_id). */
export async function setFollowAction(orgId: string, subject: TimelineSubject, follow: boolean): Promise<ActionResult> {
  const parsed = subjectSchema.safeParse(subject);
  if (!parsed.success || !validArg(booleanArg, follow)) return fail(INVALID_ARGS);
  const { kind, id } = parsed.data;
  const context = await actionContext(orgId, id);
  if (!context.ok) return context;
  const column = SUBJECT_COLUMN[kind];

  if (follow) {
    const { error } = await context.supabase.from("record_followers").insert({
      organization_id: orgId,
      lead_id: kind === "lead" ? id : null,
      contact_id: kind === "contact" ? id : null,
      company_id: kind === "company" ? id : null,
      deal_id: kind === "deal" ? id : null,
    });
    // already following (a second tab, a double click): the wish holds
    if (error && error.code !== "23505") {
      return fail(error.code === "42501" ? CANNOT_FOLLOW : dbErrorMessage(error));
    }
  } else {
    const { error } = await context.supabase
      .from("record_followers")
      .delete()
      .eq("organization_id", orgId)
      .eq(column, id)
      .eq("user_id", context.user.id);
    // nothing to remove means not following already, which is what was asked
    if (error) return fail(dbErrorMessage(error));
  }
  revalidatePath(RECORD_PATH[kind](orgId, id));
  return ok();
}
