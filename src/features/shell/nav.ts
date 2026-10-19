import type { ComponentType, SVGProps } from "react";

import {
  BoardIcon,
  BuildingIcon,
  CalendarIcon,
  ChartIcon,
  CheckSquareIcon,
  HomeIcon,
  InboxIcon,
  OrderIcon,
  QuoteIcon,
  SettingsIcon,
  TagIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { calendarPath } from "@/features/calendar/range";
import { DEFAULT_MODULES, type OrgModules } from "@/features/modules/modules";
import { ordersPath } from "@/features/orders/paths";
import { productsPath } from "@/features/products/paths";
import { quotesPath } from "@/features/quotes/paths";
import { DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";
import { paths } from "@/lib/paths";

export type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  // matches the exact path only (the home item), not everything below it
  exact?: boolean;
  // one of the four destinations of the phone bottom bar; the rest are under "עוד"
  mobile: boolean;
};

/**
 * FLD-10: leads, contacts and deals carry the business's own words (today's words by default).
 * LEAD-08: a switched-off module is left out; with leads off, contacts take their place in the phone bottom bar.
 */
export function navItems(orgId: string, terms: OrgTerms = DEFAULT_TERMS, modules: OrgModules = DEFAULT_MODULES): NavItem[] {
  const items: NavItem[] = [
    { key: "home", label: "בית", href: paths.org(orgId), icon: HomeIcon, exact: true, mobile: true },
    { key: "leads", label: terms.lead.plural, href: paths.leads(orgId), icon: InboxIcon, mobile: true },
    { key: "contacts", label: terms.contact.plural, href: paths.contacts(orgId), icon: UsersIcon, mobile: !modules.leads },
    { key: "companies", label: "חברות", href: paths.companies(orgId), icon: BuildingIcon, mobile: false },
    { key: "deals", label: terms.deal.plural, href: paths.deals(orgId), icon: BoardIcon, mobile: true },
    { key: "tasks", label: "משימות", href: paths.tasks(orgId), icon: CheckSquareIcon, mobile: true },
    // QUO-16 (owner, 18 October 2026): under "עוד" on a phone. Shown to everyone, like deals and products: the menu does
    // not know the plan's features
    { key: "quotes", label: "הצעות מחיר", href: quotesPath(orgId), icon: QuoteIcon, mobile: false },
    // ORD-01: under "עוד" on a phone; only while the plan holds orders and the business switched them on (withOrdersPlan)
    { key: "orders", label: "הזמנות", href: ordersPath(orgId), icon: OrderIcon, mobile: false },
    // CAL-02: under "עוד" on a phone; the four bottom-bar places stay as they are
    { key: "calendar", label: "יומן", href: calendarPath(orgId), icon: CalendarIcon, mobile: false },
    // PRD-01: under "עוד" on a phone
    { key: "products", label: "מוצרים", href: productsPath(orgId), icon: TagIcon, mobile: false },
    { key: "reports", label: "דוחות", href: paths.reports(orgId), icon: ChartIcon, mobile: false },
    { key: "settings", label: "הגדרות", href: paths.settings(orgId), icon: SettingsIcon, mobile: false },
  ];
  return items.filter((item) => moduleOn(item.key, modules));
}

/** LEAD-08: whether a menu or "+" entry belongs to a module the business switched off (ORD-01: orders also need the plan). */
function moduleOn(key: string, modules: OrgModules): boolean {
  if (key === "leads" || key === "lead") return modules.leads;
  if (key === "companies" || key === "company") return modules.companies;
  if (key === "orders" || key === "order") return modules.orders;
  return true;
}

export type CreateItem = {
  key: "lead" | "contact" | "company" | "deal" | "task";
  label: string;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

/** REC-08: what the "+" button of the top bar can create; each opens that type's own create screen. */
export function createItems(orgId: string, terms: OrgTerms = DEFAULT_TERMS, modules: OrgModules = DEFAULT_MODULES): CreateItem[] {
  const items: CreateItem[] = [
    { key: "lead", label: terms.lead.newOne, href: paths.leadNew(orgId), icon: InboxIcon },
    { key: "contact", label: terms.contact.newOne, href: paths.contactNew(orgId), icon: UsersIcon },
    { key: "company", label: "חברה חדשה", href: paths.companyNew(orgId), icon: BuildingIcon },
    { key: "deal", label: terms.deal.newOne, href: paths.dealNew(orgId), icon: BoardIcon },
    { key: "task", label: "משימה חדשה", href: paths.taskNew(orgId), icon: CheckSquareIcon },
  ];
  return items.filter((item) => moduleOn(item.key, modules));
}

export function isActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}
