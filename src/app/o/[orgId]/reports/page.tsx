import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { toCompletePath } from "@/features/data-quality/paths";
import { documentsPath } from "@/features/documents/paths";
import { paymentsPath } from "@/features/payments/paths";
import { ManagerDashboard } from "@/features/reports/components/manager-dashboard";
import { getDashboard } from "@/features/reports/dashboard";
import { REPORTS, reportTexts } from "@/features/reports/definitions";
import { getOrgTerms } from "@/features/terminology/queries";
import { withReportShape } from "@/features/reports/schemas";
import { canViewCosts } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { seesBalances } from "@/features/balances/queries";
import { getOrgModules } from "@/features/modules/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "דוחות" };

export default async function ReportsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { role, org } = await getOrgContext(orgId);
  // DLI-06: a report about costs is listed only for those who may see costs
  const seesCosts = canViewCosts(role, await getMyPermissions(orgId));
  // BAL-03: a report about customers' balances is listed only for those who open a ledger
  const balances = await seesBalances(orgId);
  // QUO-17: a report of a plan capability is listed only while the business has it (each capability read once)
  const features = [...new Set(REPORTS.flatMap((report) => (report.feature ? [report.feature] : [])))];
  const hasFeature = new Map(await Promise.all(features.map(async (key) => [key, await orgHasFeature(orgId, key)] as const)));
  // LST-09: the money lists, each while the plan has its key (owner, 21 October 2026: reached from here and the record cards)
  const [hasDocuments, hasPayments] = await Promise.all([orgHasFeature(orgId, "documents"), orgHasFeature(orgId, "payments")]);
  // LEAD-08: a leads-only report is left out while the leads module is off (the page itself still opens from a saved link)
  const modules = await getOrgModules(orgId);
  // FLD-10: report titles in the business's words
  const terms = await getOrgTerms(orgId);
  const reports = REPORTS.filter(
    (report) => (!report.costs || seesCosts) && (!report.balances || balances) && (!report.feature || hasFeature.get(report.feature) === true) && (report.module !== "leads" || modules.leads),
  );
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
            {hasDocuments ? (
              <ButtonLink href={documentsPath(orgId)} variant="secondary" size="sm">
                מסמכים חשבונאיים
              </ButtonLink>
            ) : null}
            {hasPayments ? (
              <ButtonLink href={paymentsPath(orgId)} variant="secondary" size="sm">
                תשלומים
              </ButtonLink>
            ) : null}
          </span>
        }
      />
      {dashboard?.ok ? <ManagerDashboard dashboard={dashboard.value} orgId={orgId} /> : null}
      {dashboard && !dashboard.ok ? <FormError message={dashboard.message} className="mb-6" /> : null}
      <h2 className="mb-3 text-lg font-semibold">כל הדוחות</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {reports.map((report) => (
          <li key={report.key}>
            <Link
              href={paths.report(orgId, report.key)}
              className="block h-full rounded-lg border border-line bg-surface p-4 hover:border-accent hover:bg-accent-soft/40"
            >
              <span className="block font-semibold">{reportTexts(report, terms).title}</span>
              <span className="mt-1 block text-md text-ink-soft">{reportTexts(report, terms).description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
