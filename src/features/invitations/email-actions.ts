"use server";

import { createHash } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getViewSeatUsage } from "@/features/settings/plan-usage";
import { INVITABLE_ROLES } from "@/features/settings/permissions";
import { NO_VIEW_SEAT_LEFT, viewSeatsLeft } from "@/features/settings/view-seats";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { MembershipRole } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

import { emailQueueText, parseInviteAddresses } from "./addresses";

/** One address's outcome: emailed (queued), or a link to copy, or not invited at all. */
export type InviteResult =
  | { email: string; status: "emailed" }
  | { email: string; status: "link"; link: string; note: string | null }
  | { email: string; status: "failed"; message: string };

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

async function queueEmail(supabase: Supabase, orgId: string, invitationId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data, error } = await supabase.rpc("invitation_email_queue", { p_org: orgId, p_invitation: invitationId });
  if (error) return { ok: false, reason: "error" };
  const answer = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return answer.ok === true ? { ok: true } : { ok: false, reason: typeof answer.reason === "string" ? answer.reason : "error" };
}

/**
 * USR-09 (owner (387) א): invites one or several addresses at once with create_invitation (seat rules unchanged), and, when
 * asked, sends each invitation by email through the queue (invite.send). An emailed invitation shows no link: the email's
 * own link replaces it. When email is not available, or over its limits, the link is shown to copy, as before.
 */
export async function inviteUsersAction(orgId: string, _prev: FormState<{ results: InviteResult[] }>, formData: FormData): Promise<FormState<{ results: InviteResult[] }>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = parseInviteAddresses(formData.get("emails"));
  if (!parsed.ok) return fail(parsed.message, { fieldErrors: { emails: parsed.message }, values: formValues(formData) });
  const role = formData.get("role");
  if (typeof role !== "string" || !(INVITABLE_ROLES as readonly string[]).includes(role)) {
    return fail("בחרו תפקיד.", { fieldErrors: { role: "בחרו תפקיד." }, values: formValues(formData) });
  }
  const byEmail = formData.get("send_email") === "on";
  // PRM-02: viewer invitations only while enough view seats are free (open viewer invitations count too)
  if (role === "viewer") {
    const seats = await getViewSeatUsage(orgId);
    const left = seats ? viewSeatsLeft(seats) : null;
    if (left !== null && left < parsed.emails.length) return fail(NO_VIEW_SEAT_LEFT, { values: formValues(formData) });
  }
  const origin = await siteOrigin();
  const results: InviteResult[] = [];
  for (const email of parsed.emails) {
    const { data: token, error } = await context.supabase.rpc("create_invitation", { p_organization_id: orgId, p_email: email, p_role: role as MembershipRole });
    if (error || !token) {
      results.push({ email, status: "failed", message: dbErrorMessage(error, "לא הצלחנו ליצור את ההזמנה.") });
      continue;
    }
    const link = `${origin}${paths.invite(token)}`;
    if (!byEmail) {
      results.push({ email, status: "link", link, note: null });
      continue;
    }
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const { data: rows, error: readError } = await context.supabase.from("invitations").select("id").eq("organization_id", orgId).eq("token_hash", hash).limit(1);
    const invitationId = readError ? undefined : rows?.[0]?.id;
    const queued = invitationId ? await queueEmail(context.supabase, orgId, invitationId) : { ok: false as const, reason: "error" };
    results.push(queued.ok ? { email, status: "emailed" } : { email, status: "link", link, note: emailQueueText(queued.reason) });
  }
  revalidatePath(paths.settingsUsers(orgId));
  return ok({ results });
}

/** "Send again" on a pending invitation: a new email whose link replaces the previous one (rate-limited in the database). */
export async function resendInvitationEmailAction(orgId: string, invitationId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, invitationId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("invitation_email_queue", { p_org: orgId, p_invitation: invitationId });
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשלוח את ההזמנה. נסו שוב."));
  const answer = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  if (answer.ok !== true) return fail(emailQueueText(typeof answer.reason === "string" ? answer.reason : "error") ?? NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.settingsUsers(orgId));
  return { ok: true, message: "ההזמנה תישלח באימייל בדקות הקרובות." };
}
