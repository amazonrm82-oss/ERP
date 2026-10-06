import { cn } from "@/lib/cn";

import type { Dashboard } from "../dashboard";
import { ReportBody } from "./report-body";

const TREND = {
  up: { mark: "▲", className: "text-success" },
  down: { mark: "▼", className: "text-danger" },
  same: { mark: "●", className: "text-ink-soft" },
} as const;

/** Business at a glance for owners, admins and team managers. */
export function ManagerDashboard({ dashboard }: { dashboard: Dashboard }) {
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
      <ReportBody view={{ kpis: [], sections: [dashboard.reps, dashboard.stuck].filter((s) => s !== null) }} />
    </section>
  );
}
