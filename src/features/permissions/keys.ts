import type { MembershipRole } from "@/lib/database.types";

// PRM-01: individual permissions on top of the role. The closed list mirrors
// app.member_permission_keys() and the check constraint member_permissions_known
// (migration member_permissions); tests/unit/member-permissions.test.ts reads the
// migration and tests/db/110-member-permissions.test.ts the database.
//
// `built: false` marks a key whose module does not exist yet: it is stored and
// can be granted once the module is built, and the screen lists only built keys.
// The module, when built, asks app.has_permission(org, key) and flips `built`.

export const MEMBER_PERMISSION_KEYS = [
  "issue_documents",
  "issue_credits",
  "record_payments",
  "view_costs",
  "export",
  "import",
  "edit_catalog",
  "mass_send",
  "manage_automations",
] as const;

export type MemberPermission = (typeof MEMBER_PERMISSION_KEYS)[number];

export type MemberPermissionInfo = {
  key: MemberPermission;
  label: string;
  description: string;
  built: boolean;
  // shown next to the checkbox (owner, 15 October 2026: automations)
  warning?: string;
  // ticking the box asks first, with the warning (owner, 15 October 2026: automations)
  confirm?: true;
};

/** Owner, 15 October 2026 (option א): the automations permission works on every record of the business. */
export const AUTOMATIONS_WARNING =
  "הרשאה זו נותנת גישה בפועל לכל הרשומות בעסק, גם לכאלה שהעובד לא רשאי לראות. לתת רק למי שסומכים עליו כמו על מנהל מערכת.";

export const MEMBER_PERMISSIONS: readonly MemberPermissionInfo[] = [
  { key: "export", label: "ייצוא", description: "הורדת רשימות ודוחות לקובץ Excel או CSV, מהרשומות שהמשתמש רואה.", built: true },
  { key: "import", label: "ייבוא", description: "העלאת לידים, אנשי קשר, חברות, עסקאות ומשימות מקובץ, וביטול ייבוא שלו בשבעת הימים הראשונים.", built: true },
  { key: "edit_catalog", label: "עריכת קטלוג", description: "הוספה ועריכה של מוצרים, קטגוריות, יחידות מידה ומחירונים.", built: true },
  {
    key: "manage_automations",
    label: "ניהול אוטומציות",
    description: "יצירה, עריכה והפעלה של אוטומציות.",
    built: true,
    warning: AUTOMATIONS_WARNING,
    confirm: true,
  },
  { key: "issue_documents", label: "הפקת מסמכים", description: "הפקת חשבוניות וקבלות.", built: false },
  { key: "issue_credits", label: "זיכוי", description: "הפקת מסמכי זיכוי.", built: false },
  { key: "record_payments", label: "רישום תשלומים", description: "רישום תשלומים שהתקבלו.", built: false },
  { key: "view_costs", label: "צפייה בעלות וברווח", description: "מחיר העלות והרווח של מוצרים ועסקאות.", built: false },
  { key: "mass_send", label: "שליחה המונית", description: "שליחת הודעה לקבוצה גדולה של לקוחות.", built: false },
];

/** The keys whose module is built: app.member_permission_built_keys() (unit test). */
export const BUILT_MEMBER_PERMISSIONS: readonly MemberPermission[] = MEMBER_PERMISSIONS.filter((p) => p.built).map((p) => p.key);

export function isMemberPermission(value: string): value is MemberPermission {
  return (MEMBER_PERMISSION_KEYS as readonly string[]).includes(value);
}

/** Only managers and members receive extra permissions; owners and admins hold them all. */
export function canReceivePermissions(role: MembershipRole): boolean {
  return role === "manager" || role === "member";
}

/**
 * The rule of app.has_permission(): owners and admins hold every key, a manager or
 * member what they were granted (`granted` comes from my_permissions(), which already
 * applies the plan capability and the session checks).
 */
export function hasPermission(role: MembershipRole, granted: readonly string[], key: MemberPermission): boolean {
  return role === "owner" || role === "admin" || (canReceivePermissions(role) && granted.includes(key));
}

/** app.can_export(): owners, admins and team managers, or the grant. */
export function canExportWith(role: MembershipRole, granted: readonly string[]): boolean {
  return role === "manager" || hasPermission(role, granted, "export");
}

/** app.can_import() without the writable check: owners, admins and team managers, or the grant. */
export function canImportWith(role: MembershipRole, granted: readonly string[]): boolean {
  return role === "manager" || hasPermission(role, granted, "import");
}

/** app.can_edit_catalog(): owners and admins, or the grant. */
export function canEditCatalog(role: MembershipRole, granted: readonly string[]): boolean {
  return hasPermission(role, granted, "edit_catalog");
}

/** app.can_manage_automations(): owners and admins, or the grant. */
export function canManageAutomations(role: MembershipRole, granted: readonly string[]): boolean {
  return hasPermission(role, granted, "manage_automations");
}
