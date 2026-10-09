"use client";

import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/**
 * The "new task" card (FXU-10). On a phone it comes first and stays folded
 * behind one button, so the list is not pushed down; on a computer it is
 * always open beside the list.
 */
export function NewTaskPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <Button variant="secondary" className="w-full lg:hidden" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <PlusIcon className="size-4.5" />
        משימה חדשה
      </Button>
      <div id={id} className={cn(open ? "mt-3 block" : "hidden", "lg:mt-0 lg:block")}>
        {children}
      </div>
    </div>
  );
}
