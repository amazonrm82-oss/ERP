"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { conflictLines, type ConflictReport, type Span } from "../conflicts";

type Props = {
  report: ConflictReport;
  // the time being set
  span: Span;
  timeZone: string;
  // what the user can do: save anyway, pick another time
  children?: ReactNode;
  className?: string;
  heading?: string;
};

/**
 * The conflict warning (CAL-05): who has another meeting then, who is outside
 * their working hours, a rest day of the business. A warning, not an error:
 * the buttons under it save anyway. It takes the focus when it appears: the
 * button that was pressed (or the item that was dragged) may be gone, and the
 * focus must not drop to the page.
 */
export function ConflictWarning({ report, span, timeZone, children, className, heading = "שימו לב, יש התנגשות בזמן הזה:" }: Props) {
  const lines = conflictLines(report, span, timeZone);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [report]);
  return (
    <div ref={ref} tabIndex={-1} role="alert" className={cn("rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-warning", className)}>
      <p className="font-semibold">{heading}</p>
      <ul className="mt-1 list-disc space-y-0.5 ps-5">
        {lines.map((line) => (
          <li key={line.key}>
            {line.text}
            {line.time ? (
              <>
                {", "}
                <span dir="ltr" className="tabular-nums">
                  {line.time}
                </span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {children ? <div className="mt-2.5 flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}
