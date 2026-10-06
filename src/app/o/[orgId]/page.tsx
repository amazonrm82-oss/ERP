import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getMyDay } from "@/features/home/queries";
import { leadDisplayName } from "@/features/leads/display";
import { getOrgContext } from "@/features/shell/queries";
import { CompleteTaskButton } from "@/features/tasks/components/complete-task-button";
import { TaskQuickAdd } from "@/features/tasks/components/task-quick-add";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

type Props = { params: Promise<{ orgId: string }> };

// The title template of this segment's layout does not apply to its own page.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgId } = await params;
  const { org } = await getOrgContext(orgId);
  return { title: { absolute: `היום שלי | ${org.name}` } };
}

export default async function HomePage({ params }: Props) {
  const { orgId } = await params;
  const { user, canWrite } = await getOrgContext(orgId);
  const day = await getMyDay(orgId, user.id);

  const overdueCount = day.tasks.filter((task) => task.isOverdue).length;
  const firstName = user.displayName.split(" ")[0];

  const summary = [
    {
      label: "משימות להיום ובאיחור",
      value: formatNumber(day.tasks.length),
      note: overdueCount > 0 ? `${formatNumber(overdueCount)} באיחור` : null,
    },
    { label: "לידים חדשים שמחכים לי", value: formatNumber(day.newLeadsCount), note: null },
    { label: "העסקאות הפתוחות שלי", value: formatNumber(day.openDealsCount), note: formatMoney(day.openDealsTotalAgorot) },
  ];

  return (
    <>
      <PageHeader title="היום שלי" description={`שלום ${firstName}, ${formatDate(new Date().toISOString())}.`} />

      <dl className="mb-5 grid divide-y divide-line rounded-lg border border-line bg-surface sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {summary.map((item) => (
          <div key={item.label} className="flex items-baseline justify-between gap-3 px-4 py-3 sm:block sm:px-5 sm:py-4">
            <dt className="text-[0.9375rem] text-ink-soft">{item.label}</dt>
            <dd className="flex items-baseline gap-2 sm:mt-1">
              <span className="text-2xl font-semibold leading-none">{item.value}</span>
              {item.note ? <span className="text-sm text-ink-soft">{item.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Card aria-labelledby="my-tasks-title">
          <CardHeader id="my-tasks-title" title="משימות להיום ובאיחור" />
          <CardBody>
            {canWrite ? (
              <div className="mb-4">
                <TaskQuickAdd orgId={orgId} today={day.today} />
              </div>
            ) : null}
            {day.tasks.length === 0 ? (
              <p className="text-[0.9375rem] text-ink-soft">אין משימות פתוחות להיום. משימה שתוסיפו עם תאריך של היום תופיע כאן.</p>
            ) : (
              <ul className="divide-y divide-line">
                {day.tasks.map((task) => (
                  <li key={task.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="block break-words">{task.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                        {task.dueAt ? <time dateTime={task.dueAt}>{formatDate(task.dueAt)}</time> : null}
                        {task.isOverdue ? <Badge tone="danger">באיחור</Badge> : null}
                      </span>
                    </span>
                    {canWrite ? <CompleteTaskButton orgId={orgId} taskId={task.id} title={task.title} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card aria-labelledby="my-leads-title">
          <CardHeader
            id="my-leads-title"
            title="לידים חדשים שמחכים לי"
            action={
              <ButtonLink href={paths.leads(orgId)} variant="ghost" size="sm">
                לכל הלידים
              </ButtonLink>
            }
          />
          <CardBody>
            {day.newLeads.length === 0 ? (
              <p className="text-[0.9375rem] text-ink-soft">אין לידים חדשים שמשויכים אליך. ליד חדש שיוקצה לך יופיע כאן עד שהסטטוס שלו ישתנה.</p>
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {day.newLeads.map((lead) => (
                    <li key={lead.id} className="py-2.5 first:pt-0 last:pb-0">
                      <Link href={paths.lead(orgId, lead.id)} className="font-medium underline-offset-4 hover:underline">
                        {leadDisplayName(lead)}
                      </Link>
                      <span className="block text-sm text-ink-soft">
                        {lead.companyName ? `${lead.companyName}, ` : ""}
                        נוצר ב-<time dateTime={lead.createdAt}>{formatDate(lead.createdAt)}</time>
                      </span>
                    </li>
                  ))}
                </ul>
                {day.newLeadsCount > day.newLeads.length ? (
                  <p className="mt-3 text-sm text-ink-soft">
                    ועוד {formatNumber(day.newLeadsCount - day.newLeads.length)} לידים חדשים ברשימת הלידים.
                  </p>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
