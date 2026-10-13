import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";

import { goalMetric } from "../metrics";
import {
  countsDeals,
  goalDealsHref,
  metricValue,
  paceFromText,
  periodEndLabel,
  periodLabel,
  progressFigures,
  requiredPerDayText,
  STANDING_LABELS,
  type GoalProgress,
} from "../progress";

type Item = GoalProgress & { subject: string; today: string };

/**
 * Goals with what was done so far: actual, goal, percent and the linear pace to the end of the
 * period (GOL-03). The bar is decoration; every number is in the text. The pace shows from a quarter of the
 * period on; before that, what is needed per day and when the pace will show (owner, 13 October 2026).
 */
export function GoalProgressList({ items, showSubject = true, orgId }: { items: Item[]; showSubject?: boolean; orgId?: string }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => {
        const figures = progressFigures(item, item.today);
        const metric = goalMetric(item.metric);
        const standing = figures.standing ? STANDING_LABELS[figures.standing] : null;
        const fill = Math.min(100, Math.max(0, figures.percent ?? 0));
        return (
          <li key={item.goalId} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 font-medium">
                {showSubject ? (
                  <>
                    <bdi>{item.subject}</bdi>
                    {" · "}
                  </>
                ) : null}
                {metric.label}
              </span>
              <span className="text-sm text-ink-soft">{periodLabel(item.period, item.periodStart)}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="tabular-nums">
                {metricValue(item.metric, item.actual)} <span className="text-ink-soft">מתוך</span> {metricValue(item.metric, item.target)}
              </span>
              <span className="flex items-center gap-2">
                {standing ? <Badge tone={standing.tone}>{standing.label}</Badge> : null}
                <span className="text-lg font-semibold tabular-nums">{figures.percent === null ? "—" : `${formatNumber(figures.percent)}%`}</span>
              </span>
            </div>
            <span aria-hidden="true" className="mt-2 block h-2 rounded-full bg-canvas">
              <span
                className={cn("block h-2 rounded-full", figures.standing === "reached" ? "bg-success" : "bg-accent")}
                style={{ width: `${fill > 0 ? Math.max(2, fill) : 0}%` }}
              />
            </span>
            {figures.phase === "pace" && figures.projected !== null ? (
              <p className="mt-1.5 text-sm text-ink-soft">
                קצב צפוי {periodEndLabel(item.period)}: {metricValue(item.metric, figures.projected)}
                {figures.projectedPercent === null ? "" : ` (${formatNumber(figures.projectedPercent)}%)`}
              </p>
            ) : null}
            {figures.requiredPerDay !== null ? (
              <p className="mt-1.5 text-sm text-ink-soft">כדי להגיע ליעד צריך {requiredPerDayText(item.metric, figures.requiredPerDay)} ביום</p>
            ) : null}
            {figures.phase === "early" ? <p className="mt-0.5 text-sm text-ink-soft">{paceFromText(figures.paceFrom)}</p> : null}
            {orgId && item.scope === "team" && item.subjectId && countsDeals(item.metric) ? (
              <p className="mt-1 text-sm">
                <Link href={goalDealsHref(orgId, item.subjectId, item.period, item.periodStart)} className="text-accent-strong underline underline-offset-4">
                  העסקאות שנספרו ביעד של {item.subject}
                </Link>
              </p>
            ) : null}
            {figures.phase === "over" ? <p className="mt-1.5 text-sm text-ink-soft">התקופה הסתיימה.</p> : null}
            {figures.phase === "upcoming" ? <p className="mt-1.5 text-sm text-ink-soft">התקופה עוד לא התחילה.</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
