import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import { buttonClasses, iconButtonClasses } from "@/components/ui/button";
import { Checkbox, SelectField } from "@/components/ui/field";
import { BackIcon, ChatIcon, ForwardIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { BlockTimeButton } from "@/features/calendar/components/block-time";
import { CalendarBoard, type CalendarEntry } from "@/features/calendar/components/calendar-board";
import { CalendarDoneToggle } from "@/features/calendar/components/done-toggle";
import { CALENDAR_LIMIT, listCalendarItems, listCalendarTeams, type CalendarItem } from "@/features/calendar/queries";
import {
  calendarPath,
  CALENDAR_VIEWS,
  isDoneOrCancelled,
  parseDay,
  parseShowDone,
  parseView,
  rangeBounds,
  stepDay,
  viewDays,
  viewTitle,
  VIEW_LABEL,
  type CalendarQuery,
} from "@/features/calendar/range";
import { tomorrowPath } from "@/features/calendar/tomorrow";
import { parsePeople, pickPeople, PEOPLE_MAX, teammatesOf, teamPeople, visibleTeams } from "@/features/calendar/team";
import { holidaysByDay } from "@/features/calendar-days/holidays";
import { listMeetingTypeChoices } from "@/features/meeting-types/queries";
import { listActivityTypes } from "@/features/activity-types/queries";
import { taskTypeName, type ActivityTypeOption } from "@/features/activity-types/types";
import type { MeetingTypeChoice } from "@/features/meeting-types/schema";
import { MEETING_STATUS_LABEL, MEETING_TYPE_LABEL } from "@/features/meetings/schema";
import { PrintAgenda } from "@/features/print/components/print-agenda";
import { PrintButton } from "@/features/print/components/print-button";
import { PrintHeader } from "@/features/print/components/print-header";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatNumber, zoneDate } from "@/lib/format";
import { recordPage } from "@/lib/record-types";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "יומן" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TASK_STATUS_LABEL: Record<string, string> = { open: "פתוחה", done: "בוצעה" };
const RELATED_LABEL = { lead: "פתיחת הליד", contact: "פתיחת איש הקשר", company: "פתיחת החברה", deal: "פתיחת העסקה" } as const;

function entry(orgId: string, item: CalendarItem, meetingTypes: ReadonlyMap<string, MeetingTypeChoice>, activityTypes: ReadonlyArray<ActivityTypeOption>): CalendarEntry {
  const meeting = item.kind === "meeting";
  // CAL-08: a deleted type is gone (the link was cleared); a hidden one still shows
  const meetingType = meeting && item.meetingTypeId ? (meetingTypes.get(item.meetingTypeId) ?? null) : null;
  // GAP-07: blocked time
  if (item.block) {
    return {
      id: item.id,
      kind: item.kind,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      title: item.title,
      kindLabel: "זמן חסום",
      typeLabel: "זמן חסום",
      statusLabel: MEETING_STATUS_LABEL[item.status] ?? item.status,
      meetingTypeName: null,
      tone: null,
      closed: item.status === "cancelled",
      ownerName: item.ownerName,
      location: null,
      related: null,
      people: item.people,
      block: true,
    };
  }
  return {
    id: item.id,
    kind: item.kind,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    title: item.title,
    kindLabel: meeting ? "פגישה" : "משימה",
    // TASK-08: a task shows the business's type (hidden ones too), else its code's built-in name
    typeLabel: meeting ? (MEETING_TYPE_LABEL[item.type] ?? item.type) : taskTypeName({ taskType: item.type, activityTypeId: item.activityTypeId }, activityTypes),
    statusLabel: (meeting ? MEETING_STATUS_LABEL[item.status] : TASK_STATUS_LABEL[item.status]) ?? item.status,
    meetingTypeName: meetingType?.name ?? null,
    tone: meetingType?.color ?? null,
    closed: isDoneOrCancelled(item.kind, item.status),
    ownerName: item.ownerName,
    location: item.location,
    related: item.related ? { href: recordPage(item.related.type, orgId, item.related.id), label: RELATED_LABEL[item.related.type] } : null,
    people: item.people,
    block: false,
  };
}

/**
 * The calendar (CAL-02): meetings and tasks with a due time, by day, week,
 * month or as an agenda, in the organization's time zone. The URL holds the
 * view, the day and whose calendar (`who`: empty = mine, "all", or a member).
 * CAL-04: `team` narrows it to a team (with its sub-teams; empty `who` then
 * means the whole team), and the side-by-side view shows a day with a column
 * per person (`p`, or a default). Items are read with the user's session, so
 * a column shows only what the user may already see.
 * Done tasks and cancelled / no-show meetings are hidden unless `done=1`
 * (owner, 12 October 2026); the switch keeps it on every link.
 */
export default async function CalendarPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const timeZone = context.org.timeZone;
  const me = context.user.id;
  const query = await searchParams;
  const today = zoneDate(new Date(), timeZone);
  const requestedView = parseView(firstParam(query.view));
  const view = requestedView ?? "week";
  const day = parseDay(firstParam(query.date), today);
  const showDone = parseShowDone(firstParam(query.done));
  // `done` rides along on every link of the screen
  const done = showDone || undefined;

  const [allMembers, teamData, meetingTypes, activityTypes] = await Promise.all([
    listMembers(orgId),
    listCalendarTeams(orgId),
    listMeetingTypeChoices(orgId),
    listActivityTypes(orgId),
  ]);
  const typeById = new Map(meetingTypes.map((type) => [type.id, type]));
  const members = allMembers.filter((member) => member.status === "active").map((member) => ({ id: member.userId, name: member.name }));
  const teams = visibleTeams(teamData.teams, teamData.memberships, me, {
    isAdmin: context.role === "owner" || context.role === "admin",
    visibility: teamData.visibility,
  });
  const team = teams.find((t) => t.id === firstParam(query.team)) ?? null;
  // the people the filters may pick from: the team's, or everyone
  const pool = team ? teamPeople(team.id, teamData.teams, teamData.memberships, members) : members;

  const whoParam = firstParam(query.who);
  const teammate = pool.find((member) => member.id === whoParam && member.id !== me);
  // "who" on links: undefined = mine (or the whole team when a team is chosen)
  const who = teammate ? teammate.id : whoParam === "all" && !team ? "all" : undefined;
  const scope: Pick<CalendarQuery, "who" | "team" | "done"> = { who, team: team?.id, done };

  const side = view === "people" ? pickPeople({ requested: parsePeople(query.p), pool, me, teammates: teammatesOf(me, teamData.memberships), teamChosen: team !== null }) : null;
  // whose items to read; null = everyone the user can see
  const people = side ? side.people.map((p) => p.id) : teammate ? [teammate.id] : team ? pool.map((p) => p.id) : who === "all" ? null : [me];
  const linkScope: CalendarQuery = view === "people" ? { team: team?.id, people: parsePeople(query.p).length > 0 ? side?.people.map((p) => p.id) : undefined, done } : scope;

  const days = viewDays(view, day);
  const { items, truncated } = await listCalendarItems(orgId, rangeBounds(days, timeZone), people, showDone);
  const entries = items.map((item) => entry(orgId, item, typeById, activityTypes));
  const holidays = Object.fromEntries(holidaysByDay(days[0], days[days.length - 1]));

  const href = (target: { view?: typeof view; date?: string }) =>
    calendarPath(orgId, { view: target.view ?? (requestedView ?? undefined), date: target.date ?? (day === today ? undefined : day), ...linkScope });
  const stepLabel = { day: ["היום הקודם", "היום הבא"], week: ["השבוע הקודם", "השבוע הבא"], month: ["החודש הקודם", "החודש הבא"], agenda: ["הימים הקודמים", "הימים הבאים"], people: ["היום הקודם", "היום הבא"] }[view];
  const whose =
    view === "people"
      ? ` זה לצד זה${team ? `, צוות ${team.name}` : ""}`
      : teammate
        ? ` של ${teammate.name}`
        : team
          ? ` של צוות ${team.name}`
          : who === "all"
            ? " של כל מי שאני רואה"
            : " שלי";

  return (
    <>
      <PrintHeader orgName={context.org.name} timeZone={timeZone} />
      <PageHeader
        title="יומן"
        description={`פגישות ומשימות עם מועד${whose}.`}
        actions={
          <>
            {/* GAP-11: the shown days as a plain list on paper */}
            <PrintButton />
            {context.canWrite ? <BlockTimeButton orgId={orgId} today={today} timeZone={timeZone} /> : null}
            <Link href={tomorrowPath(orgId)} className={buttonClasses("secondary", "md", "print:hidden")}>
              <ChatIcon className="size-5 text-accent" />
              תזכורות למחר
            </Link>
          </>
        }
      />

      <Tabs
        label="תצוגת היומן"
        className="mb-4 print:hidden"
        items={CALENDAR_VIEWS.map((option) => ({
          href: calendarPath(orgId, { view: option, date: day === today ? undefined : day, ...(option === "people" || view === "people" ? { team: team?.id, done } : scope) }),
          label: VIEW_LABEL[option],
          current: option === view,
        }))}
      />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div className="flex items-center gap-1">
          <Link href={href({ date: stepDay(view, day, -1) })} aria-label={stepLabel[0]} title={stepLabel[0]} className={iconButtonClasses("secondary")}>
            <BackIcon className="size-5" />
          </Link>
          <Link href={href({ date: stepDay(view, day, 1) })} aria-label={stepLabel[1]} title={stepLabel[1]} className={iconButtonClasses("secondary")}>
            <ForwardIcon className="size-5" />
          </Link>
          <Link href={calendarPath(orgId, { view: requestedView ?? undefined, ...linkScope })} className={buttonClasses("secondary", "md", "ms-1")}>
            היום
          </Link>
          <h2 className="ms-2 text-lead font-semibold">
            {viewTitle(view, day)}
          </h2>
        </div>

        <Form action={calendarPath(orgId)} className="flex flex-wrap items-end gap-2">
          {requestedView ? <input type="hidden" name="view" value={requestedView} /> : null}
          {day !== today ? <input type="hidden" name="date" value={day} /> : null}
          {showDone ? <input type="hidden" name="done" value="1" /> : null}
          {teams.length > 0 ? (
            <SelectField label="צוות" name="team" defaultValue={team?.id ?? ""} className="min-w-0 w-44">
              <option value="">{view === "people" ? "כולם" : "בלי סינון לפי צוות"}</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectField>
          ) : null}
          {view === "people" ? null : (
            <SelectField label="של מי" name="who" defaultValue={who ?? ""} className="min-w-0 w-48">
              {team ? (
                <option value="">כל הצוות</option>
              ) : (
                <>
                  <option value="">שלי</option>
                  <option value="all">כל מי שאני רואה</option>
                </>
              )}
              {pool
                .filter((member) => member.id !== me)
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
            </SelectField>
          )}
          <button type="submit" className={buttonClasses("secondary")}>
            הצגה
          </button>
        </Form>
      </div>

      <div className="mb-4 print:hidden">
        <CalendarDoneToggle
          checked={showDone}
          onHref={calendarPath(orgId, { view: requestedView ?? undefined, date: day === today ? undefined : day, ...linkScope, done: true })}
          offHref={calendarPath(orgId, { view: requestedView ?? undefined, date: day === today ? undefined : day, ...linkScope, done: undefined })}
        />
      </div>

      {side ? (
        <details className="mb-4 rounded-lg border border-line bg-surface print:hidden">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-md font-medium">
            בחירת אנשים ({formatNumber(side.people.length)} מוצגים)
          </summary>
          <Form action={calendarPath(orgId)} className="space-y-3 border-t border-line px-4 py-3">
            <input type="hidden" name="view" value="people" />
            {day !== today ? <input type="hidden" name="date" value={day} /> : null}
            {team ? <input type="hidden" name="team" value={team.id} /> : null}
            {showDone ? <input type="hidden" name="done" value="1" /> : null}
            <fieldset>
              <legend className="mb-2 text-sm text-ink-soft">עד {formatNumber(PEOPLE_MAX)} אנשים{team ? ` מצוות ${team.name}` : ""}.</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {pool.map((member) => (
                  <Checkbox key={member.id} name="p" value={member.id} label={member.id === me ? `${member.name} (אני)` : member.name} defaultChecked={side.people.some((p) => p.id === member.id)} />
                ))}
              </div>
            </fieldset>
            <button type="submit" className={buttonClasses("secondary")}>
              הצגה
            </button>
          </Form>
        </details>
      ) : null}

      {side?.more ? (
        <p role="status" className="mb-3 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          מוצגים {formatNumber(PEOPLE_MAX)} אנשים ראשונים. אפשר לבחור אחרים ב&quot;בחירת אנשים&quot;.
        </p>
      ) : null}

      {truncated ? (
        <p role="status" className="mb-3 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          יש כאן יותר מ-{formatNumber(CALENDAR_LIMIT)} פגישות או משימות. מוצגות הראשונות; כדאי לבחור תצוגה קצרה יותר או אדם אחד.
        </p>
      ) : null}

      <PrintAgenda
        title={viewTitle(view, day)}
        days={days}
        items={entries}
        timeZone={timeZone}
        peopleNames={side ? Object.fromEntries(side.people.map((p) => [p.id, p.name])) : undefined}
      />
      <div className="print:hidden">
        <CalendarBoard
          orgId={orgId}
          view={view}
          focusDay={day}
          days={days}
          today={today}
          items={entries}
          timeZone={timeZone}
          canMove={context.canWrite}
          scope={scope}
          people={side?.people ?? []}
          autoView={requestedView === null}
          holidays={holidays}
          members={context.canWrite ? members.map((member) => ({ userId: member.id, name: member.id === me ? `${member.name} (אני)` : member.name })) : []}
          meetingTypes={context.canWrite ? meetingTypes : []}
        />
      </div>

      {side ? <p className="mt-3 text-sm text-ink-soft print:hidden">בכל עמודה מוצג רק מה שמותר לך לראות.</p> : null}
    </>
  );
}
