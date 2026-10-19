"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { MoreIcon } from "@/components/ui/icons";

import { cn } from "@/lib/cn";

import type { OrgTerms } from "@/features/terminology/terms";

import { isActive, navItems } from "../nav";

/** Fixed sidebar navigation (start side: right in RTL). Desktop and tablet. */
export function SidebarNav({ orgId, terms }: { orgId: string; terms?: OrgTerms }) {
  const pathname = usePathname();
  return (
    <nav aria-label="ניווט ראשי">
      <ul className="space-y-0.5">
        {navItems(orgId, terms).map((item) => {
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
                {item.label}
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
export function BottomNav({ orgId, extra, terms }: { orgId: string; extra: ExtraLink[]; terms?: OrgTerms }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const all = navItems(orgId, terms);
  const items = all.filter((item) => item.mobile);
  const rest = all.filter((item) => !item.mobile);
  const moreActive = rest.some((item) => isActive(pathname, item));
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
            <MoreIcon className="size-5.5" />
            <span>עוד</span>
          </button>
        </li>
      </ul>
      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="עוד" variant="sheet">
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
                  {item.label}
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
      </Dialog>
    </nav>
  );
}
