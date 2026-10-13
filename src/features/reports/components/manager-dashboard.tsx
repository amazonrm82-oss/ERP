import { Card, CardBody, CardHeader } from "@/components/ui/card";
import Link from "next/link";

import { GoalProgressList } from "@/features/goals/components/goal-progress-list";
import { goalDealsHref, periodLabel } from "@/features/goals/progress";
import { formatMoney, formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";

import type { Dashboard } from "../dashboard";
import { ReportBody } from "./report-body";

const TREND = {
  up: { mark: "▲", className: "text-success" },
  down: { mark: "▼", className: "text-danger" },
  same: { mark: "●", className: "text-ink-soft" },
} as const;

/** Business at a glance for owners, admins and team managers. */
export function ManagerDashboard({ dashboard, orgId }: { dashboard: Dashboard; orgId: string }) {
  return (
    <section aria-labelledby="dashboard-title" className="mb-8 space-y-5">
      <h2 id="dashboard-title" className="text-lg font-semibold">
        תמונת מצב
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {dashboard.tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-line bg-surface p-4">
            <dt className="text-sm text-ink-soft">{tile.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{tile.value}</dd>
            {tile.change ? (
              <dd className="mt-0.5 text-sm text-ink-soft">
                {tile.trend ? (
                  <span aria-hidden="true" className={cn("me-1", TREND[tile.trend].className)}>
                    {TREND[tile.trend].mark}
                  </span>
                ) : null}
                {tile.change}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
      {dashboard.goals.length > 0 ? (
        <Card aria-labelledby="dashboard-goals-title">
          <CardHeader id="dashboard-goals-title" title="עמידה ביעדים" />
          <CardBody>
            <GoalProgressList items={dashboard.goals} orgId={orgId} />
            {dashboard.unteamed.length > 0 ? (
              <ul className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
                {dashboard.unteamed.map((u) => (
                  <li key={`${u.period}:${u.periodStart}`}>
                    <Link href={goalDealsHref(orgId, "none", u.period, u.periodStart)} className="text-accent-strong underline underline-offset-4">
                      {formatNumber(u.deals)} עסקאות בסך {formatMoney(u.amount)} לא משויכות לצוות
                    </Link>{" "}
                    <span className="text-ink-soft">({periodLabel(u.period, u.periodStart)})</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
      <ReportBody view={{ kpis: [], sections: [dashboard.reps, dashboard.stuck].filter((s) => s !== null) }} />
    </section>
  );
}
