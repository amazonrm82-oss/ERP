import { paths } from "@/lib/paths";

// The platform panel's menu (src/app/admin/layout.tsx). Every page in it is open to all platform staff;
// each page decides itself what a role may change (e.g. only the platform owner edits VAT rates).
export const ADMIN_NAV = [
  { href: paths.admin, label: "מדדים" },
  { href: paths.adminOrgs, label: "ארגונים" },
  { href: paths.adminUsers, label: "משתמשים" },
  { href: paths.adminPlans, label: "חבילות" },
  // ADM-01
  { href: paths.adminVat, label: 'שיעורי מע"מ' },
  { href: paths.adminStaff, label: "צוות" },
  { href: paths.adminLog, label: "יומן" },
  { href: paths.adminDesign, label: "עיצוב" },
] as const;
