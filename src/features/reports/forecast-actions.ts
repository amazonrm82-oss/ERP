"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, invalid, ok, type FormState } from "@/lib/action-result";
import { isCalendarDate } from "@/lib/calendar-date";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

const PAST_DATE = "בחרו תאריך מהיום והלאה.";

const closeDateSchema = z.object({
  expected_close_date: z.string().refine(isCalendarDate, "בחרו תאריך."),
});

/**
 * GOL-04: a new expected close date for an open deal from the forecast screen's overdue list, with
 * the user's session (RLS decides; 0 rows = deleted, closed or not permitted). A date in the
 * current month puts the deal in the month's forecast at once.
 */
export async function setExpectedCloseDateAction(orgId: string, dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const parsed = closeDateSchema.safeParse(pick(formData, ["expected_close_date"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  // a date already gone would leave the deal overdue: from today on, in the organization's zone
  const org = await context.supabase.from("organizations").select("timezone").eq("id", orgId);
  if (org.error) {
    return fail(dbErrorMessage(org.error, "לא הצלחנו לשמור את התאריך. נסו שוב."));
  }
  const timeZone = org.data[0]?.timezone;
  if (!timeZone) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (parsed.data.expected_close_date < zoneDate(new Date(), timeZone)) {
    return fail(PAST_DATE, { fieldErrors: { expected_close_date: PAST_DATE } });
  }
  const { data, error } = await context.supabase
    .from("deals")
    .update({ expected_close_date: parsed.data.expected_close_date })
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .eq("status", "open")
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את התאריך. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.report(orgId, "forecast"));
  revalidatePath(paths.deal(orgId, dealId));
  revalidatePath(paths.deals(orgId));
  return ok();
}
