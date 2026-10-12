import type { ComponentType, SVGProps } from "react";

import {
  BoardIcon,
  BuildingIcon,
  CalendarIcon,
  ChartIcon,
  CheckSquareIcon,
  HomeIcon,
  InboxIcon,
  SettingsIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { calendarPath } from "@/features/calendar/range";
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

export function navItems(orgId: string): NavItem[] {
  return [
    { key: "home", label: "בית", href: paths.org(orgId), icon: HomeIcon, exact: true, mobile: true },
    { key: "leads", label: "לידים", href: paths.leads(orgId), icon: InboxIcon, mobile: true },
    { key: "contacts", label: "אנשי קשר", href: paths.contacts(orgId), icon: UsersIcon, mobile: false },
    { key: "companies", label: "חברות", href: paths.companies(orgId), icon: BuildingIcon, mobile: false },
    { key: "deals", label: "עסקאות", href: paths.deals(orgId), icon: BoardIcon, mobile: true },
    { key: "tasks", label: "משימות", href: paths.tasks(orgId), icon: CheckSquareIcon, mobile: true },
    // CAL-02: under "עוד" on a phone; the four bottom-bar places stay as they are
    { key: "calendar", label: "יומן", href: calendarPath(orgId), icon: CalendarIcon, mobile: false },
    { key: "reports", label: "דוחות", href: paths.reports(orgId), icon: ChartIcon, mobile: false },
    { key: "settings", label: "הגדרות", href: paths.settings(orgId), icon: SettingsIcon, mobile: false },
  ];
}

export function isActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}
