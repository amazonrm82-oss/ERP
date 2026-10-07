import "server-only";

import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { AGREEMENT_VERSION } from "@/features/legal/agreement";
import { requireUser, type SessionUser } from "@/lib/auth";
import type { MembershipRole, OrgStatus, SubscriptionStatus } from "@/lib/database.types";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export type OrgContext = {
  user: SessionUser & { displayName: string };
  org: { id: string; name: string; status: OrgStatus };
  role: MembershipRole;
  // false = skipped by the lead round robin ("on vacation")
  isAvailable: boolean;
  // set when this is platform support in a customer-approved session (read-only), not a member
  supportUntil: string | null;
  subscription: {
    status: SubscriptionStatus;
    planName: string;
    trialEndsAt: string | null;
  } | null;
  // UI hints only. The database decides; these just hide actions that would fail.
  canWrite: boolean;
  canDelete: boolean;
};

const WRITABLE_STATUSES: OrgStatus[] = ["trial", "active", "past_due"];

// what public.org_context() returns; a part the caller may not see is null
type RawContext = {
  org?: { id: string; name: string; status: OrgStatus } | null;
  membership?: { role: MembershipRole; is_available: boolean } | null;
  subscription?: { status: SubscriptionStatus; plan_key: string; plan_name: string | null; trial_ends_at: string | null } | null;
  full_name?: string | null;
  agreement_version?: string | null;
};

/**
 * The signed-in user's view of an organization, or a 404.
 * RLS returns the organization row only to its active members, so "no row"
 * covers both "does not exist" and "not yours" without telling them apart.
 * Memoized per request: the layout and the page share one lookup.
 */
export const getOrgContext = cache(async (orgId: string): Promise<OrgContext> => {
  if (!isUuid(orgId)) {
    notFound();
  }
  const user = await requireUser();
  const supabase = await createClient();

  // one round trip, read with the user's rights (migration 0028)
  const { data, error } = await supabase.rpc("org_context", { p_org: orgId });
  if (error) {
    throw new Error(`organization context failed: ${error.message}`);
  }
  const ctx = (data ?? {}) as RawContext;
  const org = ctx.org ?? null;
  let membership = ctx.membership ?? null;
  let supportUntil: string | null = null;
  if (!org && !membership) {
    // a member of an organization that requires two-step verification, not yet verified
    const { data: blocked } = await supabase.rpc("mfa_required_orgs");
    if (Array.isArray(blocked) && blocked.some((b) => (b as { id?: string }).id === orgId)) {
      redirect(`${paths.loginMfa}?next=${encodeURIComponent(paths.org(orgId))}`);
    }
  }
  if (org && !membership) {
    // not a member: maybe platform support the customer let in (the database makes them a viewer)
    const { data: session } = await supabase.rpc("support_session_info", { p_org: orgId });
    const until = session && typeof session === "object" && !Array.isArray(session) ? session.expires_at : null;
    if (typeof until === "string") {
      supportUntil = until;
      membership = { role: "viewer", is_available: false };
    }
  }
  if (!org || !membership) {
    notFound();
  }
  // a customer's user signs the agreement before working (platform support in a support session does not)
  if (!supportUntil && ctx.agreement_version !== AGREEMENT_VERSION) {
    redirect(`${paths.agreement}?next=${encodeURIComponent(paths.org(orgId))}`);
  }

  const sub = ctx.subscription ?? null;
  const subscription: OrgContext["subscription"] = sub
    ? { status: sub.status, planName: sub.plan_name ?? sub.plan_key, trialEndsAt: sub.trial_ends_at }
    : null;

  const role = membership.role;
  const writable = WRITABLE_STATUSES.includes(org.status);
  const displayName = ctx.full_name?.trim() || user.fullName || user.email || "משתמש";

  return {
    user: { ...user, displayName },
    org,
    role,
    isAvailable: membership.is_available,
    supportUntil,
    subscription,
    canWrite: writable && role !== "viewer",
    // members cannot move records to the recycle bin; managers can for their own and their teams'
    canDelete: writable && (role === "owner" || role === "admin" || role === "manager"),
  };
});

/** Display names for a set of user ids (owners, authors). Missing users are simply absent. */
export async function getUserNames(userIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", ids);
  for (const profile of data ?? []) {
    names.set(profile.id, profile.full_name?.trim() || profile.email || "משתמש");
  }
  return names;
}

/**
 * UI hint: may the user edit this record? Mirrors app.can_edit_record() without
 * the team lookup (managers are shown the controls and the database decides).
 */
export function canEditRecordHint(context: OrgContext, ownerId: string | null): boolean {
  if (!context.canWrite) {
    return false;
  }
  return context.role === "owner" || context.role === "admin" || context.role === "manager" || ownerId === context.user.id;
}
