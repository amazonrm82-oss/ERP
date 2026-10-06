"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { isActive, navItems } from "../nav";

/** Fixed sidebar navigation (start side: right in RTL). Desktop and tablet. */
export function SidebarNav({ orgId }: { orgId: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="ניווט ראשי">
      <ul className="space-y-0.5">
        {navItems(orgId).map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-10 items-center gap-3 rounded-md px-3 text-[0.9375rem]",
                  active ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink hover:bg-canvas",
                )}
              >
                <item.icon className={cn("size-5 shrink-0", active ? "text-accent" : "text-ink-soft")} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Bottom bar with five destinations. Phones only. */
export function BottomNav({ orgId }: { orgId: string }) {
  const pathname = usePathname();
  const items = navItems(orgId).filter((item) => item.mobile);
  return (
    <nav
      aria-label="ניווט ראשי"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5">
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-xs",
                  active ? "font-semibold text-accent-strong" : "text-ink-soft",
                )}
              >
                <item.icon className="size-5.5" />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
