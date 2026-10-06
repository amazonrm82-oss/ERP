import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { MembershipRole, MembershipStatus, RecordVisibility, SeatType } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type OrganizationSettings = {
  name: string;
  industry: string | null;
  teamSize: string | null;
  phone: string | null;
  recordVisibility: RecordVisibility;
};

export async function getOrganizationSettings(orgId: string): Promise<OrganizationSettings | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("name, industry, team_size, phone, record_visibility")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    throw new Error(`organization settings query failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  return {
    name: data.name,
    industry: data.industry,
    teamSize: data.team_size,
    phone: data.phone,
    recordVisibility: data.record_visibility,
  };
}

/** Effective feature flag (plan + per-organization override), as app.org_has_feature() computes it. */
export async function orgHasFeature(orgId: string, key: string): Promise<boolean> {
  const supabase = await createClient();
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("plan_key, feature_overrides")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!subscription) {
    return false;
  }
  const overrides = subscription.feature_overrides;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides) && key in overrides) {
    return overrides[key] === true;
  }
  const { data: plan } = await supabase.from("plans").select("features").eq("key", subscription.plan_key).maybeSingle();
  const features = plan?.features;
  return Boolean(features && typeof features === "object" && !Array.isArray(features) && features[key] === true);
}

export type Member = {
  userId: string;
  name: string;
  email: string | null;
  role: MembershipRole;
  seatType: SeatType;
  status: MembershipStatus;
  joinedAt: string;
};

const ROLE_ORDER: MembershipRole[] = ["owner", "admin", "manager", "member", "viewer"];

/**
 * Everyone in the organization, active first, then by role and name.
 * Admins also see suspended members; for others RLS returns active rows only
 * (a suspended user is no longer a member, and their row is hidden with them).
 */
export async function listMembers(orgId: string): Promise<Member[]> {
  const supabase = await createClient();
  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("user_id, role, seat_type, status, created_at")
    .eq("organization_id", orgId);
  if (error) {
    throw new Error(`memberships query failed: ${error.message}`);
  }
  if (memberships.length === 0) {
    return [];
  }

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .in(
      "id",
      memberships.map((m) => m.user_id),
    );
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));

  const members = memberships.map((m): Member => {
    const profile = byId.get(m.user_id);
    return {
      userId: m.user_id,
      name: profile?.full_name?.trim() || profile?.email || "משתמש",
      email: profile?.email ?? null,
      role: m.role,
      seatType: m.seat_type,
      status: m.status,
      joinedAt: m.created_at,
    };
  });

  return members.sort(
    (a, b) =>
      Number(a.status !== "active") - Number(b.status !== "active") ||
      ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
      a.name.localeCompare(b.name, "he"),
  );
}

export type PendingInvitation = {
  id: string;
  email: string;
  role: MembershipRole;
  expiresAt: string;
  createdAt: string;
};

/** Invitations not yet accepted, revoked or expired. RLS shows them to admins only. */
export async function listPendingInvitations(orgId: string): Promise<PendingInvitation[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invitations")
    .select("id, email, role, expires_at, created_at")
    .eq("organization_id", orgId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`invitations query failed: ${error.message}`);
  }
  return data.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

export type TeamSummary = { id: string; name: string; memberCount: number; managerNames: string[] };

export async function listTeams(orgId: string): Promise<TeamSummary[]> {
  const supabase = await createClient();
  const [teamsResult, membersResult] = await Promise.all([
    supabase.from("teams").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("team_members").select("team_id, user_id, is_manager").eq("organization_id", orgId),
  ]);
  if (teamsResult.error) {
    throw new Error(`teams query failed: ${teamsResult.error.message}`);
  }
  const rows = membersResult.data ?? [];
  const managerIds = rows.filter((row) => row.is_manager).map((row) => row.user_id);
  const names = await getUserNames(managerIds);

  return teamsResult.data.map((team) => {
    const inTeam = rows.filter((row) => row.team_id === team.id);
    return {
      id: team.id,
      name: team.name,
      memberCount: inTeam.length,
      managerNames: inTeam.filter((row) => row.is_manager).map((row) => names.get(row.user_id) ?? "משתמש"),
    };
  });
}

export type TeamDetails = {
  id: string;
  name: string;
  members: Array<{ userId: string; name: string; email: string | null; isManager: boolean }>;
};

export async function getTeam(orgId: string, teamId: string): Promise<TeamDetails | null> {
  const supabase = await createClient();
  const { data: team, error } = await supabase
    .from("teams")
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("id", teamId)
    .maybeSingle();
  if (error) {
    throw new Error(`team query failed: ${error.message}`);
  }
  if (!team) {
    return null;
  }
  const { data: rows } = await supabase
    .from("team_members")
    .select("user_id, is_manager")
    .eq("organization_id", orgId)
    .eq("team_id", teamId);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .in(
      "id",
      (rows ?? []).map((row) => row.user_id),
    );
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));

  return {
    id: team.id,
    name: team.name,
    members: (rows ?? [])
      .map((row) => {
        const profile = byId.get(row.user_id);
        return {
          userId: row.user_id,
          name: profile?.full_name?.trim() || profile?.email || "משתמש",
          email: profile?.email ?? null,
          isManager: row.is_manager,
        };
      })
      .sort((a, b) => Number(b.isManager) - Number(a.isManager) || a.name.localeCompare(b.name, "he")),
  };
}
