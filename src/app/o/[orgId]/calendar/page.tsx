import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import { buttonClasses, iconButtonClasses } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { BackIcon, ForwardIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { CalendarBoard, type CalendarEntry } from "@/features/calendar/components/calendar-board";
import { CALENDAR_LIMIT, listCalendarItems, type CalendarItem } from "@/features/calendar/queries";
import { calendarPath, CALENDAR_VIEWS, parseDay, parseView, rangeBounds, stepDay, viewDays, viewTitle, VIEW_LABEL } from "@/features/calendar/range";
import { holidaysByDay } from "@/features/calendar-days/holidays";
import { MEETING_STATUS_LABEL, MEETING_TYPE_LABEL } from "@/features/meetings/schema";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { TASK_TYPE_OPTIONS } from "@/features/tasks/components/task-fields";
import { formatNumber, zoneDate } from "@/lib/format";
import { recordPage } from "@/lib/record-types";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "יומן" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TASK_TYPE_LABEL: Record<string, string> = Object.fromEntries(TASK_TYPE_OPTIONS.map((o) => [o.value, o.label]));
const TASK_STATUS_LABEL: Record<string, string> = { open: "פתוחה", done: "בוצעה" };
const RELATED_LABEL = { lead: "פתיחת הליד", contact: "פתיחת איש הקשר", company: "פתיחת החברה", deal: "פתיחת העסקה" } as const;

function entry(orgId: string, item: CalendarItem): CalendarEntry {
  const meeting = item.kind === "meeting";
  return {
    id: item.id,
    kind: item.kind,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    title: item.title,
    kindLabel: meeting ? "פגישה" : "משימה",
    typeLabel: (meeting ? MEETING_TYPE_LABEL[item.type] : TASK_TYPE_LABEL[item.type]) ?? item.type,
    statusLabel: (meeting ? MEETING_STATUS_LABEL[item.status] : TASK_STATUS_LABEL[item.status]) ?? item.status,
    closed: meeting ? item.status === "cancelled" || item.status === "no_show" : item.status === "done",
    ownerName: item.ownerName,
    location: item.location,
    related: item.related ? { href: recordPage(item.related.type, orgId, item.related.id), label: RELATED_LABEL[item.related.type] } : null,
  };
}

/**
 * The calendar (CAL-02): meetings and tasks with a due time, by day, week,
 * month or as an agenda, in the organization's time zone. The URL holds the
 * view, the day and whose calendar (`who`: empty = mine, "all", or a member).
 */
export default async function CalendarPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const timeZone = context.org.timeZone;
  const query = await searchParams;
  const today = zoneDate(new Date(), timeZone);
  const requestedView = parseView(firstParam(query.view));
  const view = requestedView ?? "week";
  const day = parseDay(firstParam(query.date), today);

  const members = (await listMembers(orgId)).filter((member) => member.status === "active");
  const whoParam = firstParam(query.who);
  const teammate = members.find((member) => member.userId === whoParam && member.userId !== context.user.id);
  // "who" on links: undefined = mine (the default)
  const who = whoParam === "all" ? "all" : teammate ? teammate.userId : undefined;
  const userId = who === "all" ? null : (teammate?.userId ?? context.user.id);

  const days = viewDays(view, day);
  const { items, truncated } = await listCalendarItems(orgId, rangeBounds(days, timeZone), userId);
  const entries = items.map((item) => entry(orgId, item));
  const holidays = Object.fromEntries(holidaysByDay(days[0], days[days.length - 1]));

  const href = (target: { view?: typeof view; date?: string }) =>
    calendarPath(orgId, { view: target.view ?? (requestedView ?? undefined), date: target.date ?? (day === today ? undefined : day), who });
  const stepLabel = { day: ["היום הקודם", "היום הבא"], week: ["השבוע הקודם", "השבוע הבא"], month: ["החודש הקודם", "החודש הבא"], agenda: ["הימים הקודמים", "הימים הבאים"] }[view];

  return (
    <>
      <PageHeader title="יומן" description={`פגישות ומשימות עם מועד${who === "all" ? " של כל מי שאני רואה" : teammate ? ` של ${teammate.name}` : " שלי"}.`} />

      <Tabs
        label="תצוגת היומן"
        className="mb-4"
        items={CALENDAR_VIEWS.map((option) => ({ href: calendarPath(orgId, { view: option, date: day === today ? undefined : day, who }), label: VIEW_LABEL[option], current: option === view }))}
      />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-1">
          <Link href={href({ date: stepDay(view, day, -1) })} aria-label={stepLabel[0]} title={stepLabel[0]} className={iconButtonClasses("secondary")}>
            <BackIcon className="size-5" />
          </Link>
          <Link href={href({ date: stepDay(view, day, 1) })} aria-label={stepLabel[1]} title={stepLabel[1]} className={iconButtonClasses("secondary")}>
            <ForwardIcon className="size-5" />
          </Link>
          <Link href={calendarPath(orgId, { view: requestedView ?? undefined, who })} className={buttonClasses("secondary", "md", "ms-1")}>
            היום
          </Link>
          <h2 className="ms-2 text-lead font-semibold">
            {viewTitle(view, day)}
          </h2>
        </div>

        <Form action={calendarPath(orgId)} className="flex items-end gap-2">
          {requestedView ? <input type="hidden" name="view" value={requestedView} /> : null}
          {day !== today ? <input type="hidden" name="date" value={day} /> : null}
          <SelectField label="של מי" name="who" defaultValue={who ?? ""} className="min-w-0 w-48">
            <option value="">שלי</option>
            <option value="all">כל מי שאני רואה</option>
            {members
              .filter((member) => member.userId !== context.user.id)
              .map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
          </SelectField>
          <button type="submit" className={buttonClasses("secondary")}>
            הצגה
          </button>
        </Form>
      </div>

      {truncated ? (
        <p role="status" className="mb-3 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          יש כאן יותר מ-{formatNumber(CALENDAR_LIMIT)} פגישות או משימות. מוצגות הראשונות; כדאי לבחור תצוגה קצרה יותר או אדם אחד.
        </p>
      ) : null}

      <CalendarBoard
        orgId={orgId}
        view={view}
        focusDay={day}
        days={days}
        today={today}
        items={entries}
        timeZone={timeZone}
        canMove={context.canWrite}
        who={who}
        autoView={requestedView === null}
        holidays={holidays}
      />
    </>
  );
}
