"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { buttonClasses } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";
import { SidePanel } from "@/components/ui/side-panel";

type Props = {
  title: string;
  text: string;
  // the first lead still waiting, in the queue (null = none left)
  restartHref: string | null;
  restartLabel: string;
  exitHref: string;
};

/** UX-02: the end of the queue, in the same panel (beside the list on a computer, a bottom sheet on a phone). */
export function QueueEndPanel({ title, text, restartHref, restartLabel, exitHref }: Props) {
  const router = useRouter();
  const [, startNavigation] = useTransition();
  return (
    <SidePanel
      open
      onClose={() => startNavigation(() => router.replace(exitHref, { scroll: false }))}
      title={title}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link href={exitHref} replace scroll={false} className={buttonClasses(restartHref ? "secondary" : "primary", "md")}>
            יציאה ממצב תור
          </Link>
          {restartHref ? (
            <Link href={restartHref} replace scroll={false} className={buttonClasses("primary", "md")}>
              {restartLabel}
            </Link>
          ) : null}
        </div>
      }
    >
      <div className="flex items-start gap-3">
        <CheckIcon className="mt-0.5 size-5 shrink-0 text-success" />
        <p role="status" className="text-md">
          {text}
        </p>
      </div>
    </SidePanel>
  );
}
