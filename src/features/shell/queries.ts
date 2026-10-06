import "server-only";

import { notFound } from "next/navigation";
import { cache } from "react";

import { requireUser, type SessionUser } from "@/lib/auth";
import type { MembershipRole, OrgStatus, SubscriptionStatus } from "@/lib/database.types";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export type OrgContext = {
  user: SessionUser & { displayName: string };
  org: { id: string; name: string; status: OrgStatus };
  role: MembershipRole;
  // false = skipped by the lead round robin ("on vacation")
  isAvailable: boolean;
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

  const [orgResult, membershipResult, subscriptionResult, profileResult] = await Promise.all([
    supabase.from("organizations").select("id, name, status").eq("id", orgId).is("deleted_at", null).maybeSingle(),
    supabase
      .from("memberships")
      .select("role, is_available")
      .eq("organization_id", orgId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle(),
    supabase.from("subscriptions").select("status, plan_key, trial_ends_at").eq("organization_id", orgId).maybeSingle(),
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
  ]);

  if (orgResult.error) {
    throw new Error(`organization query failed: ${orgResult.error.message}`);
  }
  const org = orgResult.data;
  const membership = membershipResult.data;
  if (!org || !membership) {
    notFound();
  }

  let subscription: OrgContext["subscription"] = null;
  if (subscriptionResult.data) {
    const { data: plan } = await supabase
      .from("plans")
      .select("name_he")
      .eq("key", subscriptionResult.data.plan_key)
      .maybeSingle();
    subscription = {
      status: subscriptionResult.data.status,
      planName: plan?.name_he ?? subscriptionResult.data.plan_key,
      trialEndsAt: subscriptionResult.data.trial_ends_at,
    };
  }

  const role = membership.role;
  const writable = WRITABLE_STATUSES.includes(org.status);
  const displayName = profileResult.data?.full_name?.trim() || user.fullName || user.email || "משתמש";

  return {
    user: { ...user, displayName },
    org,
    role,
    isAvailable: membership.is_available,
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
