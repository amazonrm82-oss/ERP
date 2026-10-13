// CON-03: the role of a contact in a deal. A fixed list of four, mirrored by the check
// constraint deal_contacts_role_check in the database (a unit test keeps the two equal).
// The database stores the key; the screen shows the label.

export const DEAL_CONTACT_ROLES = [
  { key: "decision_maker", label: "מקבל החלטה" },
  { key: "influencer", label: "משפיע" },
  { key: "user", label: "משתמש" },
  { key: "finance", label: "איש כספים" },
] as const;

export type DealContactRole = (typeof DEAL_CONTACT_ROLES)[number]["key"];

export const DEAL_CONTACT_ROLE_KEYS = DEAL_CONTACT_ROLES.map((role) => role.key) as [DealContactRole, ...DealContactRole[]];

export function isDealContactRole(value: unknown): value is DealContactRole {
  return typeof value === "string" && (DEAL_CONTACT_ROLE_KEYS as readonly string[]).includes(value);
}

/** The Hebrew label of a stored role, or null for none (and for a value this version does not know). */
export function dealContactRoleLabel(role: string | null | undefined): string | null {
  return DEAL_CONTACT_ROLES.find((option) => option.key === role)?.label ?? null;
}
