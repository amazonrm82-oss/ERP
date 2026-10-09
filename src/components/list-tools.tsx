"use client";

import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { SettingsIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

type Props = {
  // how many filters are on, shown on the button so a filtered list is never a surprise
  active?: number;
  children: ReactNode;
};

/**
 * A list's tools (saved views, filters, columns, export, view switch). On a
 * computer they sit above the list; on a phone they wait behind one button,
 * "סינון ותצוגה", so the first record is the first thing on the screen (FXU-02).
 */
export function ListTools({ active = 0, children }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mb-3">
      <Button variant="secondary" size="sm" className="md:hidden" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <SettingsIcon className="size-4.5" />
        סינון ותצוגה
        {active > 0 ? <span className="rounded-full bg-accent px-1.5 text-caption font-semibold text-on-accent tabular-nums">{active}</span> : null}
      </Button>
      <div id={id} className={cn(open ? "mt-3 flex" : "hidden", "flex-col gap-3 md:mt-0 md:flex")}>
        {children}
      </div>
    </div>
  );
}
