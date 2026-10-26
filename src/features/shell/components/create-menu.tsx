"use client";

import Link from "next/link";

import { PlusIcon } from "@/components/ui/icons";
import { Popover } from "@/components/ui/popover";

import type { OrgModules } from "@/features/modules/modules";
import type { OrgTerms } from "@/features/terminology/terms";

import { createItems } from "../nav";

/**
 * REC-08: the "+" of the top bar. Creates a lead, contact, company, deal or task
 * from any screen by opening that type's own create screen. The layout shows it
 * only to users who may write (not a viewer, not a read-only organization).
 * GAP-08: "מכירה מהירה" joins it for whoever records payments while the plan holds payments and products.
 */
export function CreateMenu({ orgId, terms, modules, quickSale = false }: { orgId: string; terms?: OrgTerms; modules?: OrgModules; quickSale?: boolean }) {
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
          {createItems(orgId, terms, modules, { quickSale }).map((item) => (
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
