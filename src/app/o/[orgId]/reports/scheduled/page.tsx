import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { getOrgModules } from "@/features/modules/queries";
import { frequencyText, periodLabel, SCHEDULE_CATALOG, scheduleEntry } from "@/features/report-schedules/catalog";
import { ScheduleForm, type ScheduleReportOption } from "@/features/report-schedules/components/schedule-form";
import { ScheduleList } from "@/features/report-schedules/components/schedule-list";
import { listReportSchedules } from "@/features/report-schedules/queries";
import { findReport, reportTexts } from "@/features/reports/definitions";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "דוחות מתוזמנים" };

/**
 * RPT-03 (owner (386) א): reports sent by email on a schedule, with a link only. Owners and admins make, switch and remove
 * them; everyone else sees the ones they receive and may take themselves off.
 */
export default async function ScheduledReportsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const canManage = isAdminRole(context.role) && context.canWrite;
  const [schedules, members, terms, modules] = await Promise.all([listReportSchedules(orgId), listMembers(orgId), getOrgTerms(orgId), getOrgModules(orgId)]);
  const titleOf = (key: string) => {
    const report = findReport(key);
    return report ? reportTexts(report, terms).title : key;
  };
  const nameOf = new Map(members.map((m) => [m.userId, m.userId === context.user.id ? `${m.name} (אני)` : m.name]));

  let options: ScheduleReportOption[] = [];
  if (canManage) {
    const keys = [...new Set(SCHEDULE_CATALOG.flatMap((e) => e.features))];
    const has = new Map(await Promise.all(keys.map(async (key) => [key, await orgHasFeature(orgId, key)] as const)));
    options = SCHEDULE_CATALOG.filter((e) => e.features.every((k) => has.get(k) === true) && (e.module !== "leads" || modules.leads)).map((e) => ({
      key: e.key,
      title: titleOf(e.key),
      hasPeriod: e.hasPeriod,
      restricted: e.restricted,
    }));
  }
  const memberOptions = members
    .filter((m) => m.status === "active")
    .map((m) => ({ userId: m.userId, name: nameOf.get(m.userId) ?? m.name, managerOrAbove: m.role === "owner" || m.role === "admin" || m.role === "manager" }));

  const items = schedules.map((s) => ({
    id: s.id,
    title: titleOf(s.reportKey),
    periodText: scheduleEntry(s.reportKey)?.hasPeriod ? periodLabel(s.period) : "מצב נוכחי",
    whenText: frequencyText(s.frequency, s.weekday, s.sendAt),
    recipientsText: s.recipients.length > 0 ? s.recipients.map((id) => nameOf.get(id) ?? "משתמש שעזב").join(", ") : "אין",
    enabled: s.enabled,
  }));

  return (
    <>
      <PageHeader
        title="דוחות מתוזמנים"
        description="דוח שנשלח במייל ביום ובשעה שבחרתם. המייל כולל רק את שם הדוח, התקופה וקישור לדוח."
        back={{ href: paths.reports(orgId), label: "כל הדוחות" }}
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title={canManage ? "הדוחות המתוזמנים של העסק" : "דוחות שאתם מקבלים"} />
          {items.length > 0 ? (
            <ScheduleList orgId={orgId} items={items} canManage={canManage} />
          ) : (
            <CardBody>
              <EmptyState compact title={canManage ? "אין עדיין דוחות מתוזמנים" : "אתם לא מקבלים דוחות מתוזמנים"} />
            </CardBody>
          )}
        </Card>
        {canManage ? (
          <Card>
            <CardHeader title="דוח מתוזמן חדש" />
            <CardBody>
              {options.length > 0 ? <ScheduleForm orgId={orgId} reports={options} members={memberOptions} /> : <p className="text-md text-ink-soft">אין דוחות זמינים לתזמון בעסק.</p>}
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
