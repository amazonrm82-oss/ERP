// CON-03: the role of a contact in a deal. Since the CON-03 follow-up (owner, 14 October 2026) the roles are a
// managed list per organization (public.deal_contact_roles, at most 20). These four are its defaults: the
// database seeds them (app.seed_deal_contact_roles, a unit test keeps the two equal), and each keeps its old
// code as `key`, so a link saved before the list (deal_contacts.role holds the code, role_id is empty) still
// finds its role.

export const DEAL_CONTACT_ROLES = [
  { key: "decision_maker", label: "מקבל החלטה" },
  { key: "influencer", label: "משפיע" },
  { key: "user", label: "משתמש" },
  { key: "finance", label: "איש כספים" },
] as const;

export type DealContactRole = (typeof DEAL_CONTACT_ROLES)[number]["key"];

export const DEAL_CONTACT_ROLE_KEYS = DEAL_CONTACT_ROLES.map((role) => role.key) as [DealContactRole, ...DealContactRole[]];

// the database refuses more (trigger deal_contact_roles_cap, hint 'deal_contact_roles:max')
export const DEAL_CONTACT_ROLES_PER_ORG = 20;
export const DEAL_CONTACT_ROLE_NAME_MAX = 60;

export function isDealContactRole(value: unknown): value is DealContactRole {
  return typeof value === "string" && (DEAL_CONTACT_ROLE_KEYS as readonly string[]).includes(value);
}

/** The default Hebrew label of an old code, or null for none (and for a value this version does not know). */
export function dealContactRoleLabel(role: string | null | undefined): string | null {
  return DEAL_CONTACT_ROLES.find((option) => option.key === role)?.label ?? null;
}

/** A role of the organization's list. */
export type DealContactRoleOption = { id: string; name: string; key: string | null; isActive: boolean };

/** A link's stored role: the list's id, and the old code of a link saved before the list. */
export type StoredLinkRole = { roleId: string | null; role: string | null };

/**
 * The role of a link on the organization's list: by its id, else (a link saved before the list) the role that
 * carries its old code. Null when it has none, or when that role was deleted.
 */
export function linkRole(link: StoredLinkRole, roles: DealContactRoleOption[]): DealContactRoleOption | null {
  if (link.roleId) return roles.find((role) => role.id === link.roleId) ?? null;
  if (link.role) return roles.find((role) => role.key === link.role) ?? null;
  return null;
}

/** The roles a person picks from: the active ones, plus the link's own role when it was hidden since. */
export function roleChoices(roles: DealContactRoleOption[], current: DealContactRoleOption | null): DealContactRoleOption[] {
  return roles.filter((role) => role.isActive || role.id === current?.id);
}
