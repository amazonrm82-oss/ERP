"use client";

import Link from "next/link";

import { iconButtonClasses } from "@/components/ui/button";
import { MoreIcon } from "@/components/ui/icons";
import { Popover } from "@/components/ui/popover";

import type { ResolvedScreenHelp } from "../tour";
import { ScreenHelpBody } from "./screen-help-popover";

export type MoreMenuLink = { href: string; label: string };

/**
 * A screen's "…" menu on a phone (UX-01 phone fixes, owner 10 November 2026): the header's secondary links and the
 * screen's help ("?"), so the header keeps one main button. Computers keep the buttons and the "?" as they are.
 */
export function ScreenMoreMenuPopover({ orgId, help, links }: { orgId: string; help: ResolvedScreenHelp; links: MoreMenuLink[] }) {
  return (
    <Popover
      trigger={<MoreIcon className="size-5" />}
      triggerLabel="עוד פעולות"
      triggerClassName={iconButtonClasses("secondary", "print:hidden")}
      label="עוד פעולות"
      align="end"
    >
      {(close) => (
        <div className="flex flex-col">
          {links.length > 0 ? (
            <ul className="border-b border-line p-2">
              {links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} onClick={close} className="flex min-h-11 items-center rounded-md px-3 text-md hover:bg-canvas">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <ScreenHelpBody orgId={orgId} help={help} onLeave={close} className="p-4" />
        </div>
      )}
    </Popover>
  );
}
