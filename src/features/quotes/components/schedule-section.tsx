import { formatDate, formatMoney } from "@/lib/format";

import { percentText, type ScheduleRow } from "../schedule";

/**
 * GAP-09 / ORD-04: the payment schedule on a customer document (a quote, an order confirmation), each step with its share
 * of the total. Nothing when there is no schedule.
 */
export function ScheduleSection({ rows, id }: { rows: readonly ScheduleRow[]; id: string }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={id} className="space-y-2" data-print-keep="">
      <h2 id={id} className="text-sm font-semibold">
        לוח תשלומים
      </h2>
      <ol className="divide-y divide-line rounded-md border border-line text-sm">
        {rows.map((step) => (
          <li key={step.key} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium break-words">
                <bdi>{step.name}</bdi>
              </p>
              {step.dueDate || step.milestone ? (
                <p className="text-ink-soft">{[step.dueDate ? formatDate(`${step.dueDate}T12:00:00Z`) : null, step.milestone].filter(Boolean).join(", ")}</p>
              ) : null}
            </div>
            <p className="shrink-0 text-end">
              <span className="block font-medium tabular-nums">{formatMoney(step.amountAgorot)}</span>
              <span className="block text-ink-soft tabular-nums">{percentText(step.percentBp)}</span>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
