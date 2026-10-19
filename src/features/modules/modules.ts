// LEAD-08: a business may switch the leads module or the companies module off (public.org_modules). Off hides the
// module in the app; it never removes data, and switching it back on shows everything again.

// ORD-01 (owner, 19 October 2026): orders are the opposite: off by default, switched on only while the plan has the
// `orders` key (the database refuses it otherwise, hint feature:orders). `ordersOfferClosed`: the one-time offer to
// switch them on, shown when a quote is accepted, was closed by an owner or admin.
export type OrgModules = { leads: boolean; companies: boolean; orders: boolean; ordersOfferClosed: boolean };

/** No row, or a failed read: leads and companies on, orders off, as every business had before. */
export const DEFAULT_MODULES: OrgModules = { leads: true, companies: true, orders: false, ordersOfferClosed: false };

export type ModuleKey = "leads" | "companies" | "orders";

export const MODULE_LABELS: Record<ModuleKey, string> = { leads: "לידים", companies: "חברות", orders: "הזמנות" };

type ModulesRow = {
  leads_enabled?: boolean | null;
  companies_enabled?: boolean | null;
  orders_enabled?: boolean | null;
  orders_offer_closed_at?: string | null;
};

/** The stored row as the app's switches; leads and companies are on unless stored off, orders only when stored on. */
export function modulesFromRow(row: ModulesRow | null): OrgModules {
  return {
    leads: row?.leads_enabled !== false,
    companies: row?.companies_enabled !== false,
    orders: row?.orders_enabled === true,
    ordersOfferClosed: Boolean(row?.orders_offer_closed_at),
  };
}

/**
 * ORD-01: the orders entries (menu) show only while the plan holds `orders` AND the business switched the module on. A
 * plan that lost the key leaves orders_enabled stored on, so the stored switch alone is not enough.
 */
export function withOrdersPlan(modules: OrgModules, ordersInPlan: boolean): OrgModules {
  return { ...modules, orders: modules.orders && ordersInPlan };
}
