import Link from "next/link";

import { cn } from "@/lib/cn";

export type TabItem = { href: string; label: string; current: boolean; count?: number };

/**
 * The one set of tabs (FXU-14): links that change the page, so the back button
 * and a shared link keep the tab. On a phone the row scrolls sideways, and the
 * current tab is marked by more than colour (a line under it and bold text).
 */
export function Tabs({ items, label, className }: { items: TabItem[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn("-mx-4 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0", className)}>
      <ul className="flex gap-1">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-md whitespace-nowrap",
                item.current ? "border-accent font-semibold text-ink" : "border-transparent text-ink-soft hover:text-ink",
              )}
            >
              {item.label}
              {item.count !== undefined ? <span className="rounded-full bg-canvas px-1.5 text-caption text-ink-soft tabular-nums">{item.count}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
