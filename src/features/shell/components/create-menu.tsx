"use client";

import Link from "next/link";

import { PlusIcon } from "@/components/ui/icons";
import { Popover } from "@/components/ui/popover";

import { createItems } from "../nav";

/**
 * REC-08: the "+" of the top bar. Creates a lead, contact, company, deal or task
 * from any screen by opening that type's own create screen. The layout shows it
 * only to users who may write (not a viewer, not a read-only organization).
 */
export function CreateMenu({ orgId }: { orgId: string }) {
  return (
    <Popover
      label="יצירה"
      triggerLabel="יצירה"
      trigger={<PlusIcon className="size-5" />}
      triggerClassName="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent hover:bg-accent-strong"
      className="sm:w-60"
    >
      {(close) => (
        <ul className="py-1.5">
          {createItems(orgId).map((item) => (
            <li key={item.key}>
              <Link href={item.href} onClick={close} className="flex min-h-11 items-center gap-3 px-4 text-md hover:bg-canvas">
                <item.icon className="size-5 shrink-0 text-ink-soft" />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
