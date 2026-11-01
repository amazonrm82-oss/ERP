import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { barPercent, chartMax, meterPercent } from "./chart-logic";

/**
 * DSN-13: one chart style for the dashboard, the reports and every progress bar.
 *
 * - Colours come only from the chart roles in globals.css (`chart-track`, `chart-bar`, `chart-done`, `chart-alert`), in both
 *   themes; every mark stands out 3:1 from its track, the card and the page (tests/unit/design-tokens.test.ts).
 * - Nothing is told by colour alone: every chart shows its numbers as text (the bar only repeats them), and the
 *   "alert" tone is striped as well as red. The words that go with a tone ("קרוב למכסה", "הושג") are the caller's.
 * - A bar that only repeats numbers shown beside it is hidden from screen readers; a meter or progress bar that stands
 *   on its own carries role, label and value text.
 * - Bars grow from the start of the line (the right in Hebrew), so they follow the reading direction.
 */
export type ChartTone = "bar" | "done" | "alert";

const FILL: Record<ChartTone, string> = {
  bar: "bg-chart-bar",
  done: "bg-chart-done",
  alert: "bg-chart-alert mx-chart-stripes",
};

const HEIGHT = { sm: "h-1.5", md: "h-2" } as const;

function Track({ percent, tone, size, animate, className }: { percent: number; tone: ChartTone; size: keyof typeof HEIGHT; animate?: boolean; className?: string }) {
  return (
    <span className={cn("block overflow-hidden rounded-full bg-chart-track", HEIGHT[size], className)}>
      <span className={cn("block h-full rounded-full", FILL[tone], animate && "transition-[width]")} style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * A comparison bar: one row's value against the largest in its chart (a report table, a list by month).
 * Decoration only: the row's number must be in the text next to it.
 */
export function ChartBar({ value, max, tone = "bar", className }: { value: number; max: number; tone?: ChartTone; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("block", className)}>
      <Track percent={barPercent(value, max)} tone={tone} size="sm" />
    </span>
  );
}

export type BarListItem = { key: string; label: ReactNode; value: number; valueText: ReactNode; tone?: ChartTone };

/**
 * A horizontal bar chart as a list: each row says its label and its number in text, with a bar under it scaled to the
 * largest value. The list itself is the text alternative (`label` names it for screen readers).
 */
export function BarList({ label, items, className }: { label: string; items: BarListItem[]; className?: string }) {
  const max = chartMax(items.map((item) => item.value));
  return (
    <ul aria-label={label} className={cn("space-y-2", className)}>
      {items.map((item) => (
        <li key={item.key} className="text-sm">
          <span className="flex justify-between gap-3">
            <span className="min-w-0">{item.label}</span>
            <span className="tabular-nums">{item.valueText}</span>
          </span>
          <ChartBar value={item.value} max={max} tone={item.tone} className="mt-1" />
        </li>
      ))}
    </ul>
  );
}

type MeterProps = {
  value: number;
  max: number;
  tone?: ChartTone;
  /** "meter" for an amount out of a limit, "progress" for a task on its way (import, setup) */
  kind?: "meter" | "progress";
  /** the numbers are in the text next to it: hide the bar from screen readers */
  decorative?: boolean;
  label?: string;
  labelledBy?: string;
  /** what a screen reader says for the value, e.g. "40%, 2 מתוך 5" */
  valueText?: string;
  /** a bar that moves while the page is open (import): its width eases, unless the reader asked for less motion */
  animate?: boolean;
  className?: string;
};

/** A meter or progress bar: `value` out of `max`, never longer than full. */
export function Meter({ value, max, tone = "bar", kind = "meter", decorative = false, label, labelledBy, valueText, animate, className }: MeterProps) {
  const track = <Track percent={meterPercent(value, max)} tone={tone} size="md" animate={animate} />;
  if (decorative) {
    return (
      <span aria-hidden="true" className={cn("block", className)}>
        {track}
      </span>
    );
  }
  return (
    <div
      role={kind === "progress" ? "progressbar" : "meter"}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className={className}
    >
      {track}
    </div>
  );
}
