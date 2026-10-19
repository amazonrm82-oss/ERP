import type { Metadata } from "next";
import Link from "next/link";

import { ContactActions } from "@/components/contact-actions";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, FormError } from "@/components/ui/feedback";
import { BoardIcon, CalendarIcon, CheckSquareIcon, InboxIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { calendarPath } from "@/features/calendar/range";
import { tomorrowPath } from "@/features/calendar/tomorrow";
import { idleText, meetingSpanText, quoteEndsSoonText, quoteWaitText } from "@/features/home/my-day";
import { quotePath, quotesPath } from "@/features/quotes/paths";
import { getMyDay } from "@/features/home/queries";
import { GoalProgressList } from "@/features/goals/components/goal-progress-list";
import { getGoalProgress, getMyMonthClosings } from "@/features/goals/progress-queries";
import { DeviceWarning } from "@/features/notifications/components/device-warning";
import { listWhatsappLog, whatsappListContext } from "@/features/whatsapp/templates";
import { PrintButton } from "@/features/print/components/print-button";
import { PrintHeader } from "@/features/print/components/print-header";
import { MEETING_STATUS_TONE } from "@/features/meetings/display";
import { MEETING_STATUS_LABEL, MEETING_TYPE_LABEL } from "@/features/meetings/schema";
import { isAdminRole } from "@/features/settings/permissions";
import { SetupChecklistCard } from "@/features/setup/components/setup-checklist-card";
import { SetupResumeCard } from "@/features/setup/components/setup-resume-card";
import { getSetupChecklist, getSetupStep } from "@/features/setup/queries";
import { getCalendarSettings } from "@/features/calendar-days/queries";
import { readPipelineCleanup } from "@/features/pipeline-cleanup/queries";
import { cleanupCountText, isCleanupDay } from "@/features/pipeline-cleanup/rules";
import { cn } from "@/lib/cn";
import { leadDisplayName } from "@/features/leads/display";
import { getOrgModules } from "@/features/modules/queries";
import { withReportShape } from "@/features/reports/schemas";
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
  const context = await getOrgContext(orgId);
  const { user, canWrite, org, role } = context;
  // WA-01 follow-up: the WhatsApp templates on the new leads; none for someone who cannot write
  const whatsappContext = whatsappListContext(context);
  // owners and admins see where the setup wizard stopped (USR-03) until it is finished,
  // and then the setup checklist (USR-04) until they close it
  const setupOwner = isAdminRole(role) && canWrite;
  const [day, setupStep, goals, modules] = await Promise.all([
    getMyDay(orgId, user.id, org.timeZone),
    setupOwner ? getSetupStep(orgId) : Promise.resolve(null),
    // GOL-03: the person's own goals whose period holds today; no goal, no card
    withReportShape(() => getGoalProgress(orgId, { userId: user.id })),
    // LEAD-08: with leads switched off, the new-leads tile and card are left out
    getOrgModules(orgId),
  ]);
  const checklist = setupOwner && !setupStep ? await getSetupChecklist(orgId, user.id) : null;
  // MNY-05: once a week, on the business's first working day of the week, the cleanup with a count
  // (a rep counts their own deals, others everything they see); nothing to decide, no card
  // HEB-02: the same settings tell the quick add when its date is a rest day
  const calendar = canWrite ? await getCalendarSettings(orgId) : null;
  const cleanup = calendar && isCleanupDay(day.today, calendar)
    ? await withReportShape(() => readPipelineCleanup(orgId, role === "member" ? user.id : null))
    : null;
  const cleanupCount = cleanup?.ok && cleanup.value ? cleanup.value.stuck.deals + cleanup.value.overdue.deals : 0;
  // no goal to show: the person's own closings this month, with no goal and no percent (owner, 13 October 2026)
  const closings = goals.ok && goals.value.length === 0 ? await withReportShape(() => getMyMonthClosings(orgId, user.id, org.timeZone)) : null;

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
    ...(modules.leads
      ? [{ label: "לידים חדשים", value: formatNumber(day.newLeadsCount), note: null, warn: false, href: paths.leads(orgId), icon: InboxIcon }]
      : []),
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
      <PrintHeader orgName={org.name} timeZone={org.timeZone} />
      <PageHeader
        title="היום שלי"
        description={`שלום ${firstName}, ${formatDate(new Date().toISOString())}.`}
        // GAP-11: the day on paper
        actions={<PrintButton />}
      />
      {/* setup, device and weekly cleanup prompts are for the screen only (GAP-11) */}
      <div className="print:hidden">
        {setupStep ? <SetupResumeCard orgId={orgId} step={setupStep} /> : null}
        {checklist && !checklist.hidden ? <SetupChecklistCard orgId={orgId} checklist={checklist} /> : null}
        <DeviceWarning orgId={orgId} />
      </div>
      {cleanupCount > 0 ? (
        <Card aria-labelledby="weekly-cleanup-title" className="mb-5 print:hidden">
          <CardHeader
            id="weekly-cleanup-title"
            title="ניקוי שבועי של העסקאות"
            action={
              <ButtonLink href={paths.dealsCleanup(orgId)} size="sm">
                לניקוי
              </ButtonLink>
            }
          />
          <CardBody>
            <p>{cleanupCountText(cleanupCount, formatNumber)}: תקועות בשלב, או שתאריך הסגירה שלהן עבר. לכל אחת: לקדם, לדחות, או לסגור.</p>
          </CardBody>
        </Card>
      ) : null}

      <ul aria-label="סיכום" className={cn("mb-5 grid gap-2 sm:gap-3", summary.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
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
        {closings ? (
          <Card aria-labelledby="my-goals-title">
            <CardHeader id="my-goals-title" title="הסגירות שלי" />
            <CardBody>
              {closings.ok ? (
                <p>
                  הסגירות שלך החודש: <span className="font-semibold tabular-nums">{formatMoney(closings.value)}</span>
                </p>
              ) : (
                <FormError message={closings.message} />
              )}
            </CardBody>
          </Card>
        ) : (
          <Card aria-labelledby="my-goals-title">
            <CardHeader
              id="my-goals-title"
              title="היעדים שלי"
              action={
                <ButtonLink href={paths.goals(orgId)} variant="ghost" size="sm" className="print:hidden">
                  לכל היעדים
                </ButtonLink>
              }
            />
            <CardBody>{goals.ok ? <GoalProgressList items={goals.value} showSubject={false} /> : <FormError message={goals.message} />}</CardBody>
          </Card>
        )}

        <Card aria-labelledby="my-meetings-title">
          <CardHeader
            id="my-meetings-title"
            title="הפגישות שלי היום"
            action={
              <span className="flex flex-wrap gap-1 print:hidden">
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
              <ButtonLink href={paths.tasks(orgId)} variant="ghost" size="sm" className="print:hidden">
                לכל המשימות
              </ButtonLink>
            }
          />
          <CardBody>
            {canWrite ? (
              <div className="mb-4 print:hidden">
                <TaskQuickAdd orgId={orgId} today={day.today} calendar={calendar ?? undefined} />
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

        {modules.leads ? (
          <Card aria-labelledby="my-leads-title">
            <CardHeader
              id="my-leads-title"
              title="לידים חדשים שמחכים לי"
              action={
                <ButtonLink href={paths.leads(orgId)} variant="ghost" size="sm" className="print:hidden">
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
                        <span className="print:hidden">
                          <ContactActions
                            phone={lead.phone}
                            phoneE164={lead.phoneE164}
                            email={null}
                            compact={{ name: leadDisplayName(lead) }}
                            whatsappLog={listWhatsappLog(whatsappContext, {
                              subject: { kind: "lead", id: lead.id },
                              name: leadDisplayName(lead),
                              phoneE164: lead.phoneE164,
                              fullName: lead.fullName,
                            })}
                          />
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
              <p className="mt-3 text-sm print:hidden">
                <Link href={paths.leadsWaiting(orgId)} className="text-accent-strong underline underline-offset-4">
                  לידים שעוד לא קיבלו מענה
                </Link>
              </p>
            </CardBody>
          </Card>
        ) : null}

        {day.waitingQuotes.length > 0 ? (
          // TASK-09: the person's quotes that wait for the customer's answer (none: no card)
          <Card aria-labelledby="my-waiting-quotes-title">
            <CardHeader
              id="my-waiting-quotes-title"
              title="הצעות שמחכות לתשובה"
              action={
                <ButtonLink href={`${quotesPath(orgId)}?${new URLSearchParams({ owner: user.id })}`} variant="ghost" size="sm" className="print:hidden">
                  לכל ההצעות
                </ButtonLink>
              }
            />
            <CardBody>
              <ul className="divide-y divide-line">
                {day.waitingQuotes.map((quote) => {
                  const endsSoon = quoteEndsSoonText(quote.validUntil, day.today);
                  return (
                    <li key={quote.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <Link href={quotePath(orgId, quote.id)} className="block break-words font-medium underline-offset-4 hover:underline">
                          {quote.numberDisplay ? (
                            <span dir="ltr" className="me-1 tabular-nums">
                              {quote.numberDisplay}
                            </span>
                          ) : null}
                          <bdi>{quote.title}</bdi>
                        </Link>
                        <span className="block text-sm text-ink-soft">
                          {quote.customerName ? (
                            <>
                              <bdi>{quote.customerName}</bdi>
                              {" · "}
                            </>
                          ) : null}
                          {quoteWaitText(quote, day.today, org.timeZone)}
                          {endsSoon ? <span className="text-warning"> · {endsSoon}</span> : null}
                        </span>
                      </div>
                      <span className="font-medium whitespace-nowrap tabular-nums">{formatMoney(quote.totalAgorot)}</span>
                    </li>
                  );
                })}
              </ul>
              {day.waitingQuotesCount > day.waitingQuotes.length ? (
                <p className="mt-3 text-sm text-ink-soft">ועוד {formatNumber(day.waitingQuotesCount - day.waitingQuotes.length)} הצעות שמחכות לתשובה.</p>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        <Card aria-labelledby="my-no-next-step-title">
          <CardHeader
            id="my-no-next-step-title"
            title="עסקאות בלי פעולה הבאה"
            action={
              <ButtonLink href={stuckReportHref} variant="ghost" size="sm" className="print:hidden">
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
