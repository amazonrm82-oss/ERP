import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { listPipelines } from "@/features/deals/queries";
import { buildReport } from "@/features/reports/build";
import { ReportBody } from "@/features/reports/components/report-body";
import { ForecastOverdueDeals } from "@/features/reports/components/forecast-overdue";
import { getOverdueActionsSetup } from "@/features/reports/forecast-overdue-server";
import { ReportFilters } from "@/features/reports/components/report-filters";
import { findReport } from "@/features/reports/definitions";
import { canExport, filtersQuery, reportFilters } from "@/features/reports/request";
import { withReportShape } from "@/features/reports/schemas";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, zonedIso } from "@/lib/format";
import { paths } from "@/lib/paths";

type Props = {
  params: Promise<{ orgId: string; report: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { report } = await params;
  return { title: findReport(report)?.title ?? "דוח" };
}

export default async function ReportPage({ params, searchParams }: Props) {
  const { orgId, report } = await params;
  const definition = findReport(report);
  if (!definition) {
    notFound();
  }
  const context = await getOrgContext(orgId);
  const filters = reportFilters(definition, await searchParams);

  const [view, members, pipelines] = await Promise.all([
    withReportShape(() => buildReport(orgId, definition.key, filters)),
    definition.filters.includes("owner") ? listMembers(orgId) : Promise.resolve([]),
    definition.filters.includes("pipeline") ? listPipelines(orgId) : Promise.resolve([]),
  ]);
  // GOL-04: the overdue deals of the forecast, with a new date, a win or a loss for those the user may change
  const overdue = view.ok && view.value.overdueDeals ? view.value.overdueDeals : null;
  const overdueSetup = overdue && overdue.length > 0 ? await getOverdueActionsSetup(context, overdue) : null;
  const overdueTotal = view.ok ? (view.value.overdueTotal ?? 0) : 0;
  const owners = members
    .filter((m) => m.status === "active" && m.role !== "viewer")
    .map((m) => ({ value: m.userId, label: m.userId === context.user.id ? `${m.name} (אני)` : m.name }));
  const { period } = filters;
  const periodText = definition.filters.includes("period")
    ? `${formatDate(zonedIso(period.fromDate, "12:00:00"))} עד ${formatDate(zonedIso(period.toDate, "12:00:00"))}`
    : "מצב נוכחי";

  return (
    <>
      <PageHeader
        title={definition.title}
        description={`${definition.description} ${periodText}.`}
        back={{ href: paths.reports(orgId), label: "כל הדוחות" }}
        actions={
          canExport(context.role) ? (
            <a href={`${paths.report(orgId, definition.key)}/export?${filtersQuery(filters)}`} className={buttonClasses("secondary", "sm")} download>
              ייצוא ל-Excel (CSV)
            </a>
          ) : null
        }
      />
      <ReportFilters
        filters={definition.filters}
        period={{ key: period.key, fromDate: period.fromDate, toDate: period.toDate }}
        ownerId={filters.ownerId ?? ""}
        owners={owners}
        pipelineId={filters.pipelineId ?? ""}
        pipelines={pipelines.map((p) => ({ value: p.id, label: p.isDefault ? `${p.name} (ברירת מחדל)` : p.name }))}
        pipelineEmptyLabel={definition.key === "funnel" ? "ברירת המחדל" : "כל הפייפליינים"}
      />
      {view.ok ? (
        <ReportBody
          view={view.value}
          replace={overdue ? { "overdue-deals": <ForecastOverdueDeals orgId={orgId} deals={overdue} total={overdueTotal} setup={overdueSetup} /> } : {}}
        />
      ) : (
        <FormError message={view.message} />
      )}
    </>
  );
}
