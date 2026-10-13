import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { toCompletePath } from "@/features/data-quality/paths";
import { ManagerDashboard } from "@/features/reports/components/manager-dashboard";
import { getDashboard } from "@/features/reports/dashboard";
import { REPORTS } from "@/features/reports/definitions";
import { withReportShape } from "@/features/reports/schemas";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "דוחות" };

export default async function ReportsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { role, org } = await getOrgContext(orgId);
  // the dashboard is for people who manage others; reps get the reports list
  const dashboard = role === "owner" || role === "admin" || role === "manager" ? await withReportShape(() => getDashboard(orgId, role === "owner" || role === "admin" ? { unteamed: { timeZone: org.timeZone } } : {})) : null;

  return (
    <>
      <PageHeader
        title="דוחות"
        description="כל דוח מציג רק את הרשומות שמותר לכם לראות."
        actions={
          <span className="flex flex-wrap gap-2">
            {/* MNY-01 */}
            <ButtonLink href={paths.moneyWaiting(orgId)} variant="secondary" size="sm">
              כסף שמחכה
            </ButtonLink>
            <ButtonLink href={paths.goals(orgId)} variant="secondary" size="sm">
              יעדים
            </ButtonLink>
            {/* DQL-01 */}
            <ButtonLink href={toCompletePath(orgId)} variant="secondary" size="sm">
              רשומות להשלמה
            </ButtonLink>
          </span>
        }
      />
      {dashboard?.ok ? <ManagerDashboard dashboard={dashboard.value} orgId={orgId} /> : null}
      {dashboard && !dashboard.ok ? <FormError message={dashboard.message} className="mb-6" /> : null}
      <h2 className="mb-3 text-lg font-semibold">כל הדוחות</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((report) => (
          <li key={report.key}>
            <Link
              href={paths.report(orgId, report.key)}
              className="block h-full rounded-lg border border-line bg-surface p-4 hover:border-accent hover:bg-accent-soft/40"
            >
              <span className="block font-semibold">{report.title}</span>
              <span className="mt-1 block text-md text-ink-soft">{report.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
