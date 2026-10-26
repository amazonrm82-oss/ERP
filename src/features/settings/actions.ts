"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { MembershipStatus } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";
import { pick } from "@/lib/validation";

import { getViewSeatUsage } from "./plan-usage";
import { NO_VIEW_SEAT_LEFT, viewSeatsLeft } from "./view-seats";
import {
  addTeamMemberSchema,
  changeRoleSchema,
  inviteSchema,
  ORGANIZATION_FIELD_NAMES,
  teamNameSchema,
  transferOwnershipSchema,
  updateOrganizationSchema,
} from "./schema";

// ---------------------------------------------------------------------------
// Business details
// ---------------------------------------------------------------------------

export async function updateOrganizationAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = updateOrganizationSchema.safeParse(pick(formData, ORGANIZATION_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const { data, error } = await context.supabase
    .from("organizations")
    .update({
      name: parsed.data.name,
      industry: parsed.data.industry || null,
      team_size: parsed.data.team_size || null,
      phone: parsed.data.phone,
      record_visibility: parsed.data.record_visibility,
    })
    .eq("id", orgId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את פרטי העסק. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }

  // the name shows in the header of every page
  revalidatePath(paths.org(orgId), "layout");
  return { ok: true, message: "פרטי העסק נשמרו." };
}

// ---------------------------------------------------------------------------
// Users and invitations
// ---------------------------------------------------------------------------

/**
 * Creates an invitation and returns its link. No email is sent yet (no email
 * provider is chosen); the admin copies the link or shares it on WhatsApp.
 * The raw token exists only in this response; the database keeps its hash.
 */
export async function inviteUserAction(
  orgId: string,
  _prev: FormState<{ link: string; email: string }>,
  formData: FormData,
): Promise<FormState<{ link: string; email: string }>> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = inviteSchema.safeParse(pick(formData, ["email", "role"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // PRM-02: a viewer invitation only while a view seat is free (open viewer invitations count too)
  if (parsed.data.role === "viewer") {
    const seats = await getViewSeatUsage(orgId);
    if (seats && viewSeatsLeft(seats) === 0) {
      return fail(NO_VIEW_SEAT_LEFT, { values: formValues(formData) });
    }
  }

  const { data: token, error } = await context.supabase.rpc("create_invitation", {
    p_organization_id: orgId,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
  });
  if (error || !token) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את ההזמנה. נסו שוב."), { values: formValues(formData) });
  }

  revalidatePath(paths.settingsUsers(orgId));
  return ok({ link: `${await siteOrigin()}${paths.invite(token)}`, email: parsed.data.email });
}

export async function revokeInvitationAction(orgId: string, invitationId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, invitationId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", invitationId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לבטל את ההזמנה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsUsers(orgId));
  return ok();
}

export async function changeMemberRoleAction(
  orgId: string,
  userId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, userId);
  if (!context.ok) {
    return context;
  }
  const parsed = changeRoleSchema.safeParse(pick(formData, ["role"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // a viewer always sits on a view seat and nobody else does (check constraint)
  const { data, error } = await context.supabase
    .from("memberships")
    .update({ role: parsed.data.role, seat_type: parsed.data.role === "viewer" ? "view" : "full" })
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשנות את התפקיד. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsUsers(orgId));
  return { ok: true, message: "התפקיד עודכן." };
}

/** Suspends a member (blocked at once, history kept) or lets them back in. */
export async function setMemberStatusAction(orgId: string, userId: string, status: MembershipStatus): Promise<ActionResult> {
  const context = await actionContext(orgId, userId);
  if (!context.ok) {
    return context;
  }
  if (status !== "active" && status !== "suspended") {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const { data, error } = await context.supabase
    .from("memberships")
    .update({ status })
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לעדכן את המשתמש. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsUsers(orgId));
  return ok();
}

/**
 * Marks a member available or not for the lead round robin. Everyone may set
 * their own; admins anyone's (RLS).
 */
export async function setAvailabilityAction(orgId: string, userId: string, available: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, available)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, userId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("memberships")
    .update({ is_available: available === true })
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsUsers(orgId));
  revalidatePath(paths.org(orgId), "layout");
  return ok();
}

export async function transferOwnershipAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = transferOwnershipSchema.safeParse(pick(formData, ["user_id", "confirm"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { error } = await context.supabase.rpc("transfer_ownership", {
    p_organization_id: orgId,
    p_new_owner: parsed.data.user_id,
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להעביר את הבעלות. נסו שוב."));
  }
  revalidatePath(paths.org(orgId), "layout");
  return { ok: true, message: "הבעלות הועברה. התפקיד שלכם עכשיו: מנהל מערכת." };
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export async function createTeamAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = teamNameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("teams")
    .insert({ organization_id: orgId, name: parsed.data.name })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את הצוות. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(paths.settingsTeams(orgId));
  redirect(paths.settingsTeam(orgId, data.id));
}

export async function renameTeamAction(
  orgId: string,
  teamId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, teamId);
  if (!context.ok) {
    return context;
  }
  const parsed = teamNameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("teams")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", teamId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את שם הצוות. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidatePath(paths.settingsTeams(orgId));
  revalidatePath(paths.settingsTeam(orgId, teamId));
  return { ok: true, message: "שם הצוות נשמר." };
}

/** Deletes the team. Records that pointed to it keep their owner and lose the team. */
export async function deleteTeamAction(orgId: string, teamId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, teamId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("teams")
    .delete()
    .eq("organization_id", orgId)
    .eq("id", teamId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק את הצוות. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsTeams(orgId));
  redirect(paths.settingsTeams(orgId));
}

export async function addTeamMemberAction(
  orgId: string,
  teamId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, teamId);
  if (!context.ok) {
    return context;
  }
  const parsed = addTeamMemberSchema.safeParse(pick(formData, ["user_id", "is_manager"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { error } = await context.supabase.from("team_members").insert({
    organization_id: orgId,
    team_id: teamId,
    user_id: parsed.data.user_id,
    is_manager: parsed.data.is_manager,
  });
  if (error) {
    const message = error.code === "23505" ? "המשתמש כבר בצוות." : dbErrorMessage(error, "לא הצלחנו להוסיף את המשתמש לצוות. נסו שוב.");
    return fail(message);
  }
  revalidatePath(paths.settingsTeams(orgId));
  revalidatePath(paths.settingsTeam(orgId, teamId));
  return ok();
}

export async function setTeamManagerAction(
  orgId: string,
  teamId: string,
  userId: string,
  isManager: boolean,
): Promise<ActionResult> {
  const context = await actionContext(orgId, teamId, userId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("team_members")
    .update({ is_manager: isManager === true })
    .eq("organization_id", orgId)
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לעדכן את הצוות. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsTeams(orgId));
  revalidatePath(paths.settingsTeam(orgId, teamId));
  return ok();
}

/**
 * Marks (or unmarks) this team as the member's primary team: the team their new
 * records join when they are in several teams (CAP-06). One step in the database,
 * which clears the previous primary team; admins only (RLS).
 */
export async function setPrimaryTeamAction(
  orgId: string,
  teamId: string,
  userId: string,
  primary: boolean,
): Promise<ActionResult> {
  const context = await actionContext(orgId, teamId, userId);
  if (!context.ok) {
    return context;
  }
  if (!validArg(booleanArg, primary)) {
    return fail(INVALID_ARGS);
  }
  const { error } = await context.supabase.rpc("set_primary_team", {
    p_org: orgId,
    p_team: teamId,
    p_user: userId,
    p_primary: primary,
  });
  if (error) {
    // P0002: no row of this member in this team was changed (gone, or not permitted)
    return fail(error.code === "P0002" ? NOT_FOUND_OR_FORBIDDEN : dbErrorMessage(error, "לא הצלחנו לעדכן את הצוות הראשי. נסו שוב."));
  }
  revalidatePath(paths.settingsTeams(orgId));
  // the member's other team pages change too (the old primary team)
  revalidatePath("/o/[orgId]/settings/teams/[teamId]", "page");
  return ok();
}

export async function removeTeamMemberAction(orgId: string, teamId: string, userId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, teamId, userId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("team_members")
    .delete()
    .eq("organization_id", orgId)
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להסיר את המשתמש מהצוות. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsTeams(orgId));
  revalidatePath(paths.settingsTeam(orgId, teamId));
  return ok();
}

/**
 * Resets two-step verification of a member who lost both the authenticator and the
 * backup codes. The database decides who may (see migration 0016).
 */
export async function resetMemberMfaAction(orgId: string, userId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("org_reset_member_mfa", { p_org: orgId, p_user: userId });
  if (error) {
    if (error.hint === "mfa:self_first") return fail("כדי לאפס לאחרים, הפעילו קודם אימות דו-שלבי בחשבון שלכם.");
    if (error.hint === "mfa_reset:other_orgs") return fail("המשתמש שייך גם לעסק אחר, ולכן רק צוות התמיכה יכול לאפס לו. הפנו אותו לתמיכה.");
    if (error.hint === "mfa_reset:none") return fail("אימות דו-שלבי כבר לא פעיל אצל המשתמש.");
    return fail(dbErrorMessage(error, "לא הצלחנו לאפס."));
  }
  revalidatePath(paths.settingsUsers(orgId));
  return ok();
}

/** Moves everything one user owns to another (owners and admins; the database checks). */
export async function transferRecordsAction(orgId: string, fromUserId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const to = formData.get("to");
  if (typeof to !== "string" || !isUuid(to)) return fail("יש לבחור למי להעביר.");
  const context = await actionContext(orgId, fromUserId, to);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("transfer_records", { p_org: orgId, p_from: fromUserId, p_to: to });
  if (error) {
    if (error.hint === "transfer:target") return fail("אפשר להעביר רק למשתמש פעיל שאינו צופה.");
    return fail(dbErrorMessage(error, "ההעברה נכשלה. נסו שוב."));
  }
  const moved = (data ?? {}) as Record<string, number>;
  revalidatePath(paths.settingsUsers(orgId));
  return {
    ok: true,
    message: `הועברו ${moved.leads ?? 0} לידים, ${moved.contacts ?? 0} אנשי קשר, ${moved.companies ?? 0} חברות, ${moved.deals ?? 0} עסקאות, ${moved.tasks ?? 0} משימות, ${moved.meetings ?? 0} פגישות, ${moved.quotes ?? 0} הצעות מחיר ו-${moved.orders ?? 0} הזמנות.`,
  };
}
