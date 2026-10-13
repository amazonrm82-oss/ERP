import "server-only";

import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { AGREEMENT_VERSION } from "@/features/legal/agreement";
import { TIME_ZONE } from "@/lib/app";
import { requireUser, type SessionUser } from "@/lib/auth";
import type { MembershipRole, OrgStatus, SubscriptionStatus } from "@/lib/database.types";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";

export type OrgContext = {
  user: SessionUser & { displayName: string };
  // timeZone and currency: the organization's own settings (dates and amounts are shown in them)
  org: { id: string; name: string; status: OrgStatus; timeZone: string; currency: string };
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
  // BIL-09 (owner, 13 October 2026): the business is suspended or cancelled, access is closed until
  // payment. The database gives no role to anyone but the owner; the app shows one screen.
  closed: boolean;
};

const WRITABLE_STATUSES: OrgStatus[] = ["trial", "active", "past_due"];
// mirrors app.org_status_closed() (migration 0161)
export const CLOSED_STATUSES: OrgStatus[] = ["suspended", "cancelled"];

/** A business the caller belongs to that is closed to them until payment (public.closed_orgs()). */
export type ClosedOrganization = { id: string; name: string; status: OrgStatus; role: MembershipRole };

export async function listClosedOrganizations(): Promise<ClosedOrganization[]> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("closed_orgs"), "closed_orgs");
  return Array.isArray(data) ? (data as unknown as ClosedOrganization[]) : [];
}

// what public.org_context() returns; a part the caller may not see is null
type RawContext = {
  org?: { id: string; name: string; status: OrgStatus; timezone?: string; currency?: string } | null;
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
 * A business closed until payment comes back with `closed: true`; most callers
 * use getOrgContext(), which sends it to the one screen it may see.
 */
const loadOrgContext = cache(async (orgId: string): Promise<OrgContext> => {
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
  const raw = ctx.org ?? null;
  // before migration 0043 the two settings are missing; the defaults are what every organization has
  const org = raw ? { id: raw.id, name: raw.name, status: raw.status, timeZone: raw.timezone ?? TIME_ZONE, currency: raw.currency ?? "ILS" } : null;
  let membership = ctx.membership ?? null;
  let supportUntil: string | null = null;
  if (!org && !membership) {
    // a member of an organization that requires two-step verification, not yet verified
    const blocked = must(await supabase.rpc("mfa_required_orgs"), "mfa_required_orgs");
    if (Array.isArray(blocked) && blocked.some((b) => (b as { id?: string }).id === orgId)) {
      redirect(`${paths.loginMfa}?next=${encodeURIComponent(paths.org(orgId))}`);
    }
    // a member of a business closed until payment: the database shows them nothing of it (0161)
    const closed = (await listClosedOrganizations()).find((c) => c.id === orgId);
    if (closed) {
      if (ctx.agreement_version !== AGREEMENT_VERSION) {
        redirect(`${paths.agreement}?next=${encodeURIComponent(paths.org(orgId))}`);
      }
      return {
        user: { ...user, displayName: ctx.full_name?.trim() || user.fullName || user.email || "משתמש" },
        org: { id: closed.id, name: closed.name, status: closed.status, timeZone: TIME_ZONE, currency: "ILS" },
        role: closed.role,
        isAvailable: false,
        supportUntil: null,
        subscription: null,
        canWrite: false,
        canDelete: false,
        closed: true,
      };
    }
  }
  if (org && !membership) {
    // not a member: maybe platform support the customer let in (the database makes them a viewer)
    const session = must(await supabase.rpc("support_session_info", { p_org: orgId }), "support_session_info");
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
    // platform support in a customer-approved session still sees the business, to help it back
    closed: CLOSED_STATUSES.includes(org.status) && !supportUntil,
  };
});

/** The context of a business the user may work in; a business closed until payment goes to its one screen. */
export async function getOrgContext(orgId: string): Promise<OrgContext> {
  const context = await loadOrgContext(orgId);
  if (context.closed) {
    redirect(paths.orgSuspended(orgId));
  }
  return context;
}

/** For the frame and the "closed until payment" screen: the context as it is, closed or not. */
export const getOrgContextAllowClosed = loadOrgContext;

/**
 * For the few pages the owner of a closed business still opens: the plan and the full export.
 * Anyone else in a closed business goes to its one screen.
 */
export async function getOrgContextForOwner(orgId: string): Promise<OrgContext> {
  const context = await loadOrgContext(orgId);
  if (context.closed && context.role !== "owner") {
    redirect(paths.orgSuspended(orgId));
  }
  return context;
}

/** Display names for a set of user ids (owners, authors). Missing users are simply absent. */
export async function getUserNames(userIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }
  const supabase = await createClient();
  const data = must(await supabase.from("profiles").select("id, full_name, email").in("id", ids), "profiles");
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
