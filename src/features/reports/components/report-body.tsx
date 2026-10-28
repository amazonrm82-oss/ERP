import Link from "next/link";
import type { ReactNode } from "react";

import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";

import type { ReportSection, ReportView } from "../definitions";
import { formatCell } from "../format";

/** Headline numbers, then one table per section. Bars are decoration: the numbers are in the table. */
export function ReportBody({ view, replace = {} }: { view: ReportView; replace?: Record<string, ReactNode> }) {
  return (
    <div className="space-y-5">
      {/* a note about the whole report (a refusal, or COL-06's partial view) */}
      {view.note ? <p className="rounded-lg border border-line bg-surface px-4 py-3 text-md text-ink-soft">{view.note}</p> : null}
      {view.kpis.length > 0 ? (
        <dl className="grid gap-3 sm:grid-cols-3">
          {view.kpis.map((kpi) => (
            <div key={kpi.label} className="rounded-lg border border-line bg-surface p-4">
              <dt className="text-sm text-ink-soft">{kpi.label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{kpi.value}</dd>
              {kpi.hint ? <dd className="mt-0.5 text-sm text-ink-soft">{kpi.hint}</dd> : null}
            </div>
          ))}
        </dl>
      ) : null}
      {view.sections.map((section, index) =>
        section.anchor && replace[section.anchor] !== undefined ? (
          <div key={section.title}>{replace[section.anchor]}</div>
        ) : (
          <Section key={section.title} section={section} id={`report-section-${index}`} />
        ),
      )}
    </div>
  );
}

function Section({ section, id }: { section: ReportSection; id: string }) {
  const barColumn = section.bar ? section.columns.find((c) => c.key === section.bar) : undefined;
  const max = barColumn ? Math.max(0, ...section.rows.map((r) => (typeof r[barColumn.key] === "number" ? (r[barColumn.key] as number) : 0))) : 0;
  const [first, ...rest] = section.columns;

  return (
    <Card aria-labelledby={id} id={section.anchor} className={section.anchor ? "scroll-mt-20" : undefined}>
      <CardHeader id={id} title={section.title} />
      {section.rows.length === 0 ? (
        <p className="px-4 py-6 text-md text-ink-soft sm:px-5">{section.empty}</p>
      ) : (
        // FXA-09: the box that scrolls sideways is reachable and named, so a keyboard can scroll it
        <div role="region" aria-label={section.title} tabIndex={0} className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-md">
            <thead>
              <tr className="border-b border-line text-sm text-ink-soft">
                <th scope="col" className="px-4 py-2.5 text-start font-medium sm:px-5">
                  {first.label}
                </th>
                {rest.map((column) => (
                  <th key={column.key} scope="col" className={cn("px-3 py-2.5 font-medium", column.kind === "text" ? "text-start" : "text-end")}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {section.rows.map((row, rowIndex) => {
                const barValue = barColumn && typeof row[barColumn.key] === "number" ? (row[barColumn.key] as number) : 0;
                const label = formatCell(first.kind, row[first.key]);
                return (
                  <tr key={rowIndex}>
                    <th scope="row" className="px-4 py-2.5 text-start font-normal sm:px-5">
                      {row._href ? (
                        <Link href={row._href} className="underline underline-offset-4 hover:text-accent-strong">
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                      {barColumn && max > 0 ? (
                        <span aria-hidden="true" className="mt-1 block h-1.5 rounded-full bg-canvas">
                          <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(2, (barValue / max) * 100)}%` }} />
                        </span>
                      ) : null}
                    </th>
                    {rest.map((column) => (
                      <td key={column.key} className={cn("px-3 py-2.5 tabular-nums", column.kind === "text" ? "text-start" : "text-end")}>
                        {formatCell(column.kind, row[column.key])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {section.note ? <p className="border-t border-line px-4 py-2.5 text-sm text-ink-soft sm:px-5">{section.note}</p> : null}
    </Card>
  );
}
