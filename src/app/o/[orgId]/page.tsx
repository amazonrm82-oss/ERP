import type { Metadata } from "next";
import Link from "next/link";

import { ContactActions } from "@/components/contact-actions";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { BoardIcon, CalendarIcon, CheckSquareIcon, InboxIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { calendarPath } from "@/features/calendar/range";
import { tomorrowPath } from "@/features/calendar/tomorrow";
import { idleText, meetingSpanText } from "@/features/home/my-day";
import { getMyDay } from "@/features/home/queries";
import { MEETING_STATUS_TONE } from "@/features/meetings/display";
import { MEETING_STATUS_LABEL, MEETING_TYPE_LABEL } from "@/features/meetings/schema";
import { isAdminRole } from "@/features/settings/permissions";
import { SetupChecklistCard } from "@/features/setup/components/setup-checklist-card";
import { SetupResumeCard } from "@/features/setup/components/setup-resume-card";
import { getSetupChecklist, getSetupStep } from "@/features/setup/queries";
import { leadDisplayName } from "@/features/leads/display";
import { getOrgContext } from "@/features/shell/queries";
import { CompleteTaskButton } from "@/features/tasks/components/complete-task-button";
import { TaskQuickAdd } from "@/features/tasks/components/task-quick-add";
import { formatDate, formatMoney, formatNumber, zoneTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { RECORD_TYPES, recordPage } from "@/lib/record-types";

type Props = { params: Promise<{ orgId: string }> };

const RELATED_LABEL = { lead: "פתיחת הליד", contact: "פתיחת איש הקשר", company: "פתיחת החברה", deal: "פתיחת העסקה" } as const;

// The title template of this segment's layout does not apply to its own page.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgId } = await params;
  const { org } = await getOrgContext(orgId);
  return { title: { absolute: `היום שלי | ${org.name}` } };
}

export default async function HomePage({ params }: Props) {
  const { orgId } = await params;
  const { user, canWrite, org, role } = await getOrgContext(orgId);
  // owners and admins see where the setup wizard stopped (USR-03) until it is finished,
  // and then the setup checklist (USR-04) until they close it
  const setupOwner = isAdminRole(role) && canWrite;
  const [day, setupStep] = await Promise.all([
    getMyDay(orgId, user.id, org.timeZone),
    setupOwner ? getSetupStep(orgId) : Promise.resolve(null),
  ]);
  const checklist = setupOwner && !setupStep ? await getSetupChecklist(orgId, user.id) : null;

  const overdueCount = day.tasks.filter((task) => task.isOverdue).length;
  const firstName = user.displayName.split(" ")[0];
  const noNextStep = day.dealsWithoutNextStep;
  const stuckReportHref = `${paths.report(orgId, "stuck")}?${new URLSearchParams({ owner: user.id })}`;

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
      {setupStep ? <SetupResumeCard orgId={orgId} step={setupStep} /> : null}
      {checklist && !checklist.hidden ? <SetupChecklistCard orgId={orgId} checklist={checklist} /> : null}

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
        <Card aria-labelledby="my-meetings-title">
          <CardHeader
            id="my-meetings-title"
            title="הפגישות שלי היום"
            action={
              <span className="flex flex-wrap gap-1">
                <ButtonLink href={tomorrowPath(orgId)} variant="ghost" size="sm">
                  תזכורות למחר
                </ButtonLink>
                <ButtonLink href={calendarPath(orgId, { view: "day" })} variant="ghost" size="sm">
                  ליומן
                </ButtonLink>
              </span>
            }
          />
          <CardBody>
            {day.meetings.length === 0 ? (
              <EmptyState compact icon={<CalendarIcon />} title="אין פגישות היום" description="פגישה שאתם מארגנים או משתתפים בה היום תופיע כאן." />
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {day.meetings.map((meeting) => (
                    <li key={meeting.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                      <time
                        dateTime={meeting.startsAt}
                        className={meeting.phase === "over" ? "shrink-0 pt-0.5 text-sm tabular-nums text-ink-soft" : "shrink-0 pt-0.5 text-sm font-medium tabular-nums"}
                        dir="ltr"
                      >
                        {meetingSpanText(meeting.startsAt, meeting.endsAt, day.today, org.timeZone)}
                      </time>
                      <span className="min-w-0">
                        <span className="block break-words">{meeting.title}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                          {meeting.phase === "now" && meeting.status === "planned" ? <Badge tone="accent">עכשיו</Badge> : null}
                          {meeting.status !== "planned" ? (
                            <Badge tone={MEETING_STATUS_TONE[meeting.status] ?? "neutral"}>{MEETING_STATUS_LABEL[meeting.status] ?? meeting.status}</Badge>
                          ) : null}
                          <span>{MEETING_TYPE_LABEL[meeting.type] ?? meeting.type}</span>
                          {meeting.location ? <bdi className="break-words">{meeting.location}</bdi> : null}
                          {meeting.related ? (
                            <Link href={recordPage(meeting.related.type, orgId, meeting.related.id)} className="text-accent-strong underline-offset-4 hover:underline">
                              {RELATED_LABEL[meeting.related.type]}
                            </Link>
                          ) : null}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                {day.meetingsTruncated ? (
                  <p className="mt-3 text-sm text-ink-soft">
                    ייתכן שיש עוד פגישות.{" "}
                    <Link href={calendarPath(orgId, { view: "day" })} className="text-accent-strong underline underline-offset-4">
                      לרשימה המלאה ביומן
                    </Link>
                  </p>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>

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
              <EmptyState compact icon={<InboxIcon />} title="אין לידים חדשים שמשויכים אליכם" description="ליד חדש שיוקצה לכם יופיע כאן עד שהסטטוס שלו ישתנה." />
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
            <p className="mt-3 text-sm">
              <Link href={paths.leadsWaiting(orgId)} className="text-accent-strong underline underline-offset-4">
                לידים שעוד לא קיבלו מענה
              </Link>
            </p>
          </CardBody>
        </Card>

        <Card aria-labelledby="my-no-next-step-title">
          <CardHeader
            id="my-no-next-step-title"
            title="עסקאות בלי פעולה הבאה"
            action={
              <ButtonLink href={stuckReportHref} variant="ghost" size="sm">
                לדוח המלא
              </ButtonLink>
            }
          />
          <CardBody>
            {noNextStep.deals.length === 0 ? (
              <EmptyState
                compact
                kind="done"
                title="לכל העסקאות שלכם יש צעד הבא"
                description="עסקה פתוחה בלי משימה פתוחה ובלי פגישה מתוכננת תופיע כאן."
              />
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {noNextStep.deals.map((deal) => (
                    <li key={deal.id} className="py-2.5 first:pt-0 last:pb-0">
                      <Link href={paths.deal(orgId, deal.id)} className="block break-words font-medium underline-offset-4 hover:underline">
                        {deal.name}
                      </Link>
                      <span className="block text-sm text-ink-soft">
                        {deal.stageName ? `${deal.stageName} · ` : ""}
                        {idleText(deal.idleDays)}
                      </span>
                    </li>
                  ))}
                </ul>
                {noNextStep.count > noNextStep.deals.length || noNextStep.truncated ? (
                  <p className="mt-3 text-sm text-ink-soft">
                    {noNextStep.truncated ? "יש עוד עסקאות כאלה" : `ועוד ${formatNumber(noNextStep.count - noNextStep.deals.length)} עסקאות כאלה`} בדוח העסקאות התקועות.
                  </p>
                ) : null}
                <p className="mt-3 text-sm text-ink-soft">כדאי לקבוע לכל עסקה משימה או פגישה, כדי שלא תישכח.</p>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
