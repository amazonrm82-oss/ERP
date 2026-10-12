import { cn } from "@/lib/cn";

import { HOLIDAY_KIND_LABELS, type Holiday, type HolidayKind } from "../holidays";

const TONES: Record<HolidayKind, string> = {
  rest: "bg-accent-soft text-accent-strong",
  erev: "bg-warning-soft text-warning",
  // a shortened working day, like an eve: the same colour (one legend entry)
  short: "bg-warning-soft text-warning",
  observance: "bg-canvas text-ink-soft",
};

const MEMORIAL_LABEL = "יום זיכרון";

type Props = {
  holidays: Holiday[];
  /** a month cell: one short line that cuts with an ellipsis; the full name stays in the tooltip and for screen readers */
  compact?: boolean;
  className?: string;
};

/**
 * The holidays of one day, for a calendar day cell or a day header (CAL-03).
 * Renders nothing on a day without holidays. Works in server and client components.
 */
export function HolidayMarks({ holidays, compact, className }: Props) {
  if (holidays.length === 0) return null;
  return (
    <ul className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      {holidays.map((holiday) => (
        <li
          key={holiday.name}
          title={`${HOLIDAY_KIND_LABELS[holiday.kind]}: ${holiday.name}${holiday.memorial ? ` (${MEMORIAL_LABEL})` : ""}`}
          // relative: keeps the sr-only spans inside the clipped mark (a long compact name pushed them past a 360px screen)
          className={cn(
            "relative min-w-0 rounded-sm px-1 text-caption font-medium leading-5",
            compact ? "truncate" : "break-words",
            TONES[holiday.kind],
          )}
        >
          {/* a shortened day says so in sight: its name alone does not tell (CAL-03, Yom HaZikaron) */}
          {holiday.kind === "short" ? null : <span className="sr-only">{HOLIDAY_KIND_LABELS[holiday.kind]}: </span>}
          {holiday.name}
          {holiday.kind === "short" ? (
            <>
              <span aria-hidden="true"> · </span>
              {HOLIDAY_KIND_LABELS.short}
            </>
          ) : null}
          {holiday.memorial ? <span className="sr-only"> ({MEMORIAL_LABEL})</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The legend entries: one per colour (an eve and a shortened day share one). */
const LEGEND: { kind: HolidayKind; label: string }[] = [
  { kind: "rest", label: HOLIDAY_KIND_LABELS.rest },
  { kind: "erev", label: `${HOLIDAY_KIND_LABELS.erev} או ${HOLIDAY_KIND_LABELS.short}` },
  { kind: "observance", label: HOLIDAY_KIND_LABELS.observance },
];

/** What the three colours mean, for under a calendar. */
export function HolidayLegend({ className }: { className?: string }) {
  return (
    <ul aria-label="מקרא חגים" className={cn("flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft", className)}>
      {LEGEND.map(({ kind, label }) => (
        <li key={kind} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("inline-block size-3 rounded-sm border border-line", TONES[kind])} />
          {label}
        </li>
      ))}
    </ul>
  );
}
