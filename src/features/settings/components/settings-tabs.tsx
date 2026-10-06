"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";

/** Section links of the settings area. Scrolls sideways on narrow screens. */
export function SettingsTabs({ orgId, showTrash, showCustomization }: { orgId: string; showTrash: boolean; showCustomization: boolean }) {
  const pathname = usePathname();
  const tabs = [
    { href: paths.settings(orgId), label: "פרטי העסק", exact: true },
    { href: paths.settingsUsers(orgId), label: "משתמשים" },
    { href: paths.settingsTeams(orgId), label: "צוותים" },
    ...(showCustomization
      ? [
          { href: paths.settingsPipelines(orgId), label: "פייפליינים" },
          { href: paths.settingsLeads(orgId), label: "סטטוסים ומקורות" },
          { href: paths.settingsFields(orgId), label: "שדות" },
          { href: paths.settingsTags(orgId), label: "תגיות" },
        ]
      : []),
    ...(showTrash ? [{ href: paths.settingsTrash(orgId), label: "סל מחזור" }] : []),
  ];

  return (
    <nav aria-label="הגדרות" className="mb-5 overflow-x-auto border-b border-line sm:mb-6">
      <ul className="flex gap-1">
        {tabs.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex min-h-11 items-center border-b-2 px-3 text-[0.9375rem] whitespace-nowrap",
                  active ? "border-accent font-semibold text-accent-strong" : "border-transparent text-ink-soft hover:text-ink",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
