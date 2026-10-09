import type { Metadata } from "next";
import Link from "next/link";

import { ContactActions } from "@/components/contact-actions";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { BoardIcon, CheckSquareIcon, InboxIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { getMyDay } from "@/features/home/queries";
import { leadDisplayName } from "@/features/leads/display";
import { getOrgContext } from "@/features/shell/queries";
import { CompleteTaskButton } from "@/features/tasks/components/complete-task-button";
import { TaskQuickAdd } from "@/features/tasks/components/task-quick-add";
import { formatDate, formatMoney, formatNumber, zoneTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { RECORD_TYPES, recordPage } from "@/lib/record-types";

type Props = { params: Promise<{ orgId: string }> };

// The title template of this segment's layout does not apply to its own page.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgId } = await params;
  const { org } = await getOrgContext(orgId);
  return { title: { absolute: `היום שלי | ${org.name}` } };
}

export default async function HomePage({ params }: Props) {
  const { orgId } = await params;
  const { user, canWrite, org } = await getOrgContext(orgId);
  const day = await getMyDay(orgId, user.id, org.timeZone);

  const overdueCount = day.tasks.filter((task) => task.isOverdue).length;
  const firstName = user.displayName.split(" ")[0];

  // three tiles that lead to the full list; three in a row on a phone too
  const summary = [
    {
      label: "משימות להיום",
      value: formatNumber(day.tasks.length),
      note: overdueCount > 0 ? `${formatNumber(overdueCount)} באיחור` : null,
      warn: overdueCount > 0,
      href: paths.tasks(orgId),
      icon: CheckSquareIcon,
    },
    { label: "לידים חדשים", value: formatNumber(day.newLeadsCount), note: null, warn: false, href: paths.leads(orgId), icon: InboxIcon },
    {
      label: "עסקאות פתוחות",
      value: formatNumber(day.openDealsCount),
      note: day.openDealsCount > 0 ? formatMoney(day.openDealsTotalAgorot) : null,
      warn: false,
      href: paths.deals(orgId),
      icon: BoardIcon,
    },
  ];

  return (
    <>
      <PageHeader title="היום שלי" description={`שלום ${firstName}, ${formatDate(new Date().toISOString())}.`} />

      <ul aria-label="סיכום" className="mb-5 grid grid-cols-3 gap-2 sm:gap-3">
        {summary.map((item) => (
          <li key={item.label}>
            <Link
              href={item.href}
              className="flex h-full flex-col gap-1 rounded-lg border border-line bg-surface p-3 hover:border-line-strong hover:bg-canvas sm:flex-row sm:items-center sm:gap-4 sm:p-4"
            >
              <span aria-hidden="true" className="hidden size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent sm:flex">
                <item.icon className="size-5.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-2xl font-semibold leading-tight tabular-nums">{item.value}</span>
                <span className="block text-caption text-ink-soft sm:text-md">{item.label}</span>
                {item.note ? (
                  <span className={item.warn ? "block text-caption font-medium text-danger" : "block text-caption text-ink-soft"}>{item.note}</span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Card aria-labelledby="my-tasks-title">
          <CardHeader
            id="my-tasks-title"
            title="משימות להיום ובאיחור"
            action={
              <ButtonLink href={paths.tasks(orgId)} variant="ghost" size="sm">
                לכל המשימות
              </ButtonLink>
            }
          />
          <CardBody>
            {canWrite ? (
              <div className="mb-4">
                <TaskQuickAdd orgId={orgId} today={day.today} />
              </div>
            ) : null}
            {day.tasks.length === 0 ? (
              <EmptyState compact kind="done" title="אין משימות פתוחות להיום" description="משימה שתוסיפו עם תאריך של היום תופיע כאן." />
            ) : (
              <ul className="divide-y divide-line">
                {day.tasks.map((task) => (
                  <li key={task.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="block break-words">{task.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                        {task.isOverdue ? <Badge tone="danger">באיחור</Badge> : null}
                        {task.dueAt ? (
                          <time dateTime={task.dueAt} className="tabular-nums">
                            {task.isOverdue ? formatDate(task.dueAt) : `היום, ${zoneTime(new Date(task.dueAt), org.timeZone)}`}
                          </time>
                        ) : null}
                        {task.related ? (
                          <Link href={recordPage(task.related.kind, orgId, task.related.id)} className="text-accent-strong underline-offset-4 hover:underline">
                            {RECORD_TYPES[task.related.kind].singular}: <bdi>{task.related.name ?? "ללא שם"}</bdi>
                          </Link>
                        ) : null}
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
              <EmptyState compact icon={<InboxIcon />} title="אין לידים חדשים שמשויכים אליך" description="ליד חדש שיוקצה לך יופיע כאן עד שהסטטוס שלו ישתנה." />
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {day.newLeads.map((lead) => (
                    <li key={lead.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="min-w-0">
                        <Link href={paths.lead(orgId, lead.id)} className="block truncate font-medium underline-offset-4 hover:underline">
                          {leadDisplayName(lead)}
                        </Link>
                        <span className="block truncate text-sm text-ink-soft">
                          {lead.companyName ? `${lead.companyName}, ` : ""}
                          נוצר ב-<time dateTime={lead.createdAt}>{formatDate(lead.createdAt)}</time>
                        </span>
                      </span>
                      <ContactActions phone={lead.phone} phoneE164={lead.phoneE164} email={null} compact={{ name: leadDisplayName(lead) }} />
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
