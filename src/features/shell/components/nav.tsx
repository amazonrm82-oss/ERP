"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Sheet } from "@/components/ui/sheet";
import { MoreIcon } from "@/components/ui/icons";

import { cn } from "@/lib/cn";

import type { OrgModules } from "@/features/modules/modules";
import type { OrgTerms } from "@/features/terminology/terms";

import { isActive, navCountText, navItems } from "../nav";

// SPD-01: counters next to menu entries, by entry key (the waiting leads nobody owns)
type NavCounts = Partial<Record<string, number | null>>;

function NavCount({ count, className }: { count: number | null | undefined; className?: string }) {
  const text = navCountText(count);
  if (!text) return null;
  return (
    <span className={cn("rounded-full bg-accent px-1.5 text-caption font-semibold text-on-accent tabular-nums", className)}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{`, ${text} בלי אחראי`}</span>
    </span>
  );
}

/** Fixed sidebar navigation (start side: right in RTL). Desktop and tablet. */
export function SidebarNav({
  orgId,
  terms,
  modules,
  counts = {},
  viewer = false,
}: {
  orgId: string;
  terms?: OrgTerms;
  modules?: OrgModules;
  counts?: NavCounts;
  viewer?: boolean;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="ניווט ראשי">
      <ul className="space-y-0.5">
        {navItems(orgId, terms, modules, { viewer }).map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-10 items-center gap-3 rounded-md px-3 text-md",
                  active ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink hover:bg-canvas",
                )}
              >
                <item.icon className={cn("size-5 shrink-0", active ? "text-accent" : "text-ink-soft")} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <NavCount count={counts[item.key]} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

type ExtraLink = { href: string; label: string };

/**
 * Bottom bar on phones (DSN-11, FXU-13): four destinations and "עוד", which
 * opens a sheet with everything else, so no screen is reachable only through
 * the user menu.
 */
export function BottomNav({
  orgId,
  extra,
  terms,
  modules,
  counts = {},
  viewer = false,
}: {
  orgId: string;
  extra: ExtraLink[];
  terms?: OrgTerms;
  modules?: OrgModules;
  counts?: NavCounts;
  viewer?: boolean;
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const all = navItems(orgId, terms, modules, { viewer });
  const items = all.filter((item) => item.mobile);
  const rest = all.filter((item) => !item.mobile);
  const moreActive = rest.some((item) => isActive(pathname, item));
  const restCount = rest.reduce((sum, item) => sum + Math.max(0, counts[item.key] ?? 0), 0);
  const cell = "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-xs";

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
                className={cn(cell, active ? "font-semibold text-accent-strong" : "text-ink-soft")}
              >
                <item.icon className="size-5.5" />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setMoreOpen(true)}
            className={cn(cell, moreActive ? "font-semibold text-accent-strong" : "text-ink-soft")}
          >
            <span className="relative">
              <MoreIcon className="size-5.5" />
              {/* SPD-01: what waits under "עוד" (the leads nobody owns) shows on the button too */}
              <NavCount count={restCount} className="absolute -top-1.5 -end-3" />
            </span>
            <span>עוד</span>
          </button>
        </li>
      </ul>
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="עוד">
        <ul className="-mx-2">
          {rest.map((item) => {
            const active = isActive(pathname, item);
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-12 items-center gap-3 rounded-md px-2 text-md",
                    active ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink hover:bg-canvas",
                  )}
                >
                  <item.icon className={cn("size-5 shrink-0", active ? "text-accent" : "text-ink-soft")} />
                  <span className="min-w-0 flex-1">{item.label}</span>
                  <NavCount count={counts[item.key]} />
                </Link>
              </li>
            );
          })}
        </ul>
        <ul className="-mx-2 mt-2 border-t border-line pt-2">
          {extra.map((link) => (
            <li key={link.href}>
              <Link href={link.href} onClick={() => setMoreOpen(false)} className="flex min-h-12 items-center rounded-md px-2 text-md text-ink hover:bg-canvas">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </Sheet>
    </nav>
  );
}
