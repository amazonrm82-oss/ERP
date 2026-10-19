// LEAD-08: a business may switch the leads module or the companies module off (public.org_modules). Off hides the
// module in the app; it never removes data, and switching it back on shows everything again.

export type OrgModules = { leads: boolean; companies: boolean };

/** No row, or a failed read: both on, as every business had before LEAD-08. */
export const DEFAULT_MODULES: OrgModules = { leads: true, companies: true };

export type ModuleKey = keyof OrgModules;

export const MODULE_LABELS: Record<ModuleKey, string> = { leads: "לידים", companies: "חברות" };

/** The stored row as the app's switches; anything missing is on. */
export function modulesFromRow(row: { leads_enabled?: boolean | null; companies_enabled?: boolean | null } | null): OrgModules {
  return { leads: row?.leads_enabled !== false, companies: row?.companies_enabled !== false };
}
