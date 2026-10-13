"use client";

import { buttonClasses } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";

import { GOAL_METRICS, GOAL_PERIOD_LABELS, GOAL_PERIODS, type GoalMetric, type GoalPeriod } from "../metrics";

type Props = { metric: GoalMetric; period: GoalPeriod; year: number; years: number[] };

/** A plain GET form: the metric, period and year live in the URL. */
export function GoalsFilters({ metric, period, year, years }: Props) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4" aria-label="בחירת יעדים">
      <SelectField label="מדד" name="metric" defaultValue={metric} className="w-48">
        {GOAL_METRICS.map((m) => (
          <option key={m.key} value={m.key}>
            {m.label}
          </option>
        ))}
      </SelectField>
      <SelectField label="תקופה" name="period" defaultValue={period} className="w-32">
        {GOAL_PERIODS.map((p) => (
          <option key={p} value={p}>
            {GOAL_PERIOD_LABELS[p]}
          </option>
        ))}
      </SelectField>
      <SelectField label="שנה" name="year" defaultValue={String(year)} className="w-28">
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </SelectField>
      <button type="submit" className={buttonClasses("secondary", "md")}>
        הצגה
      </button>
    </form>
  );
}
