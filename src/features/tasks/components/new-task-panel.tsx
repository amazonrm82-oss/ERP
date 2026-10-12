"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/**
 * The "new task" card (FXU-10). On a phone it comes first and stays folded
 * behind one button, so the list is not pushed down; on a computer it is
 * always open beside the list. Reached from the top bar's "+" (REC-08) it
 * starts open, with the focus on its first field.
 */
export function NewTaskPanel({ children, startOpen = false }: { children: ReactNode; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!startOpen) return;
    const field = panelRef.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select");
    field?.focus();
  }, [startOpen]);

  return (
    <div>
      <Button variant="secondary" className="w-full lg:hidden" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <PlusIcon className="size-4.5" />
        משימה חדשה
      </Button>
      <div ref={panelRef} id={id} className={cn(open ? "mt-3 block" : "hidden", "lg:mt-0 lg:block")}>
        {children}
      </div>
    </div>
  );
}
