import { MEMBER_PERMISSIONS, type MemberPermission } from "@/features/permissions/keys";
import type { MembershipRole } from "@/lib/database.types";

import type { PrivacyClass } from "./classes";

// PRK-01: the pure parts of the privacy center (what the page counts and lists), unit-tested.

const ROLE_ORDER: readonly MembershipRole[] = ["owner", "admin", "manager", "member", "viewer"];

// the extra permissions that move or reveal personal information (PRM-01); the others are listed only when granted
const PERSONAL_DATA_PERMISSIONS: readonly MemberPermission[] = ["export", "import", "manage_automations", "mass_send", "record_payments", "documents"];

export type RoleCount = { role: MembershipRole; count: number };

/** Active members by role, in the role order; roles with nobody are left out. */
export function activeRoleCounts(members: ReadonlyArray<{ role: MembershipRole; status: string }>): RoleCount[] {
  return ROLE_ORDER.map((role) => ({ role, count: members.filter((m) => m.status === "active" && m.role === role).length })).filter(
    (row) => row.count > 0,
  );
}

export type GrantCount = { key: MemberPermission; label: string; names: string[] };

/**
 * PRM-01 grants that touch personal information, with the active members holding each (owners and admins hold them
 * all and are not listed). Empty when nobody holds one.
 */
export function personalDataGrants(
  grants: ReadonlyMap<string, readonly string[]>,
  members: ReadonlyArray<{ userId: string; name: string; status: string; role: MembershipRole }>,
): GrantCount[] {
  const active = members.filter((m) => m.status === "active" && (m.role === "manager" || m.role === "member"));
  return MEMBER_PERMISSIONS.filter((p) => PERSONAL_DATA_PERMISSIONS.includes(p.key))
    .map((p) => ({
      key: p.key,
      label: p.label,
      names: active.filter((m) => (grants.get(m.userId) ?? []).includes(p.key)).map((m) => m.name),
    }))
    .filter((row) => row.names.length > 0);
}

export type MarkedField = { label: string; privacyClass: PrivacyClass; isActive: boolean };

/** The custom fields marked personal or sensitive, sensitive first, then by their order on the card. */
export function markedFields(fields: ReadonlyArray<{ label: string; privacyClass?: PrivacyClass | null; isActive: boolean }>): MarkedField[] {
  const marked = fields.filter((f): f is typeof f & { privacyClass: PrivacyClass } => f.privacyClass === "personal" || f.privacyClass === "sensitive");
  return [...marked.filter((f) => f.privacyClass === "sensitive"), ...marked.filter((f) => f.privacyClass === "personal")].map((f) => ({
    label: f.label,
    privacyClass: f.privacyClass,
    isActive: f.isActive,
  }));
}

/** How many active members have no second sign-in step. */
export function withoutSecondStep(members: ReadonlyArray<{ userId: string; status: string }>, withMfa: readonly string[]): number {
  const set = new Set(withMfa);
  return members.filter((m) => m.status === "active" && !set.has(m.userId)).length;
}
