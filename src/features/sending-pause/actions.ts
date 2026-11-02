"use server";

import { revalidatePath } from "next/cache";

import { saveTerms } from "@/features/terminology/save";
import { actionContext } from "@/lib/action-context";
import { fail, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { pauseSchema } from "./pause";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לעצור ולחדש את השליחה ללקוחות.";
// review L-4: the owner keeps a role in a closed business, but the switch is frozen there
const CLOSED = "העסק סגור כרגע, ולכן אי אפשר לעצור או לחדש את השליחה.";

type PauseValues = { paused: boolean; reason: string | null };

/**
 * HEB-09: writes the business's switch with the user's session (owners and admins of a business that is not closed,
 * RLS). The pause and resume times and people are stamped by the database. Update first, insert only when there is
 * no row yet (the one-row-per-business rule; never an upsert, organization_id has no update grant).
 */
async function save(orgId: string, values: PauseValues): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const supabase = context.supabase;
  const result = await saveTerms<PauseValues>(
    {
      update: (org, v) => supabase.from("org_sending_pauses").update(v).eq("organization_id", org).select("id"),
      insert: (org, v) => supabase.from("org_sending_pauses").insert({ organization_id: org, ...v }).select("id"),
    },
    orgId,
    values,
  );
  if (!result.ok) {
    if (result.error?.code !== "42501") return fail(dbErrorMessage(result.error));
    // refused by RLS: say why when the business is closed to the caller (public.closed_orgs, the caller's own businesses)
    const closed = await supabase.rpc("closed_orgs");
    const closedHere = !closed.error && Array.isArray(closed.data) && closed.data.some((row) => typeof row === "object" && row !== null && "id" in row && row.id === orgId);
    return fail(closedHere ? CLOSED : NOT_ADMIN);
  }
  // the banner sits in the business layout: every screen shows or drops it
  revalidatePath(`/o/${orgId}`, "layout");
  return {
    ok: true,
    message: values.paused ? "השליחה האוטומטית ללקוחות נעצרה. היא לא תתחדש עד שתחדשו אותה." : "השליחה האוטומטית ללקוחות חודשה.",
  };
}

export async function pauseSendingAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = pauseSchema.safeParse(pick(formData, ["reason"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  return save(orgId, { paused: true, reason: parsed.data.reason });
}

export async function resumeSendingAction(orgId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  void _formData;
  return save(orgId, { paused: false, reason: null });
}
