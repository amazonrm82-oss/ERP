"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { BackIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";

import { currentSection, settingsGroups, type SettingsAccess } from "../sections";

type Props = { orgId: string; access: SettingsAccess; children: ReactNode };

/**
 * The settings area (FXU-13, DSN-11). The settings page itself is the grouped
 * list. A section page gets its title and a way back: on a computer the list
 * stays beside it, on a phone a "הגדרות" link leads back to the list.
 * Deeper pages (a form, an automation) bring their own header.
 */
export function SettingsFrame({ orgId, access, children }: Props) {
  const pathname = usePathname();
  const groups = settingsGroups(orgId, access);
  const home = paths.settings(orgId);
  if (pathname === home) {
    return <>{children}</>;
  }
  const section = currentSection(pathname, groups, paths.settingsAccount(orgId));
  const atSection = section !== null && pathname === section.href;

  return (
    <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <nav aria-label="הגדרות" className="hidden lg:block">
        <div className="sticky top-20 flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="mb-1 px-3 text-caption font-medium text-ink-soft">{group.label}</p>
              <ul>
                {group.sections.map((item) => {
                  const active = section?.href === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-9 items-center rounded-md px-3 text-md",
                          active ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink hover:bg-canvas",
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0">
        {atSection ? (
          <header className="mb-5 sm:mb-6">
            <Link href={home} className="mb-2 inline-flex min-h-8 items-center gap-1 text-sm text-ink-soft hover:text-ink lg:hidden">
              <BackIcon className="size-4" />
              הגדרות
            </Link>
            <h1 className="text-2xl font-semibold leading-tight">{section.label}</h1>
          </header>
        ) : null}
        {children}
      </div>
    </div>
  );
}
