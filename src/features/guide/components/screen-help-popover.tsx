"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Popover } from "@/components/ui/popover";
import { iconButtonClasses } from "@/components/ui/button";
import { paths } from "@/lib/paths";

import { draftLabel, type ResolvedScreenHelp } from "../tour";

/**
 * UX-05 (ב): the "?" button of a main screen. Three short lines about the screen, the screen's video when one exists
 * (UX-07; none yet) and the way to the help center. The texts are in docs/help/screens/.
 */
export function ScreenHelpPopover({ orgId, help }: { orgId: string; help: ResolvedScreenHelp }) {
  return (
    <Popover
      trigger={
        <span aria-hidden="true" className="grid size-7 place-items-center rounded-full border-2 border-current text-md font-bold leading-none">
          ?
        </span>
      }
      triggerLabel={`עזרה: ${help.title}`}
      triggerClassName={iconButtonClasses("ghost", "text-ink-soft hover:text-ink print:hidden")}
      label={`עזרה: ${help.title}`}
      align="end"
    >
      {(close) => (
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{help.title}</p>
            {/* owner (203) ב: a placeholder text says so until the owner rewrites it */}
            {draftLabel(help.draft) ? <Badge tone="warning">{draftLabel(help.draft)}</Badge> : null}
          </div>
          <ul className="list-disc space-y-1.5 ps-5 text-md">
            {help.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3 text-md">
            {help.video ? (
              <a href={help.video} target="_blank" rel="noopener noreferrer" className="text-accent-strong underline underline-offset-4">
                סרטון קצר על המסך
                <span className="sr-only"> (נפתח בחלון חדש)</span>
              </a>
            ) : null}
            <Link href={paths.orgHelpArticle(orgId, help.article)} onClick={close} className="text-accent-strong underline underline-offset-4">
              למרכז העזרה
            </Link>
          </div>
        </div>
      )}
    </Popover>
  );
}
