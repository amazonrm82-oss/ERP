import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { CalendarIcon, ChatIcon, PhoneIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { CALENDAR_LIMIT } from "@/features/calendar/queries";
import { calendarPath } from "@/features/calendar/range";
import { noButtonReason, reminderDate, reminderValues, tomorrowOf } from "@/features/calendar/tomorrow";
import { listTomorrowMeetings } from "@/features/calendar/tomorrow-queries";
import { MEETING_TYPE_LABEL } from "@/features/meetings/schema";
import { getOrgContext } from "@/features/shell/queries";
import { WhatsappButton } from "@/features/whatsapp/components/whatsapp-button";
import { formatNumber, telUrl, whatsappUrl, zoneDate, zoneTime } from "@/lib/format";
import { recordPage } from "@/lib/record-types";

export const metadata: Metadata = { title: "תזכורות למחר" };

type Props = { params: Promise<{ orgId: string }> };

const PERSON_LINK_LABEL = { lead: "פתיחת הליד", contact: "פתיחת איש הקשר" } as const;

/**
 * GAP-03: tomorrow's meetings (in the organization's zone) that the user organizes or takes
 * part in, each with the lead or contact it is with and a WhatsApp button that opens the WA-01
 * window with the organization's meeting-reminder template filled in (date and time included)
 * and logs the message on that record's timeline. A stop-gap until automatic reminders (CAL-12).
 */
export default async function TomorrowPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const timeZone = context.org.timeZone;
  const today = zoneDate(new Date(), timeZone);
  const tomorrow = tomorrowOf(today);
  const { meetings, truncated, templateId } = await listTomorrowMeetings(orgId, context.user.id, tomorrow, today, timeZone);
  const values = { user: context.user, org: { name: context.org.name, timeZone } };

  return (
    <>
      <PageHeader
        title="תזכורות למחר"
        description={`הפגישות שלי ב${reminderDate(tomorrow)}. אפשר לשלוח לכל לקוח תזכורת ב-WhatsApp בלחיצה.`}
        back={{ href: calendarPath(orgId), label: "ליומן" }}
      />

      {truncated ? (
        <p role="status" className="mb-3 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          יש מחר יותר מ-{formatNumber(CALENDAR_LIMIT)} פגישות. מוצגות הראשונות.
        </p>
      ) : null}
      {meetings.length > 0 && templateId === null && context.canWrite ? (
        <p className="mb-3 text-sm text-ink-soft">אין תבנית של תזכורת לפגישה. אפשר לבחור תבנית אחרת או לכתוב הודעה.</p>
      ) : null}

      {meetings.length === 0 ? (
        <EmptyState
          icon={<CalendarIcon />}
          title="אין פגישות מחר"
          description="פגישה שאתם מארגנים או משתתפים בה מחר תופיע כאן."
          action={
            <Link href={calendarPath(orgId, { view: "day", date: tomorrow })} className={buttonClasses("secondary")}>
              מחר ביומן
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {meetings.map((meeting) => {
            const person = meeting.person;
            const reason = noButtonReason(meeting, person);
            const name = person ? person.fullName || person.phone || "ללא שם" : null;
            const tel = person ? telUrl(person.phoneE164, person.phone) : null;
            return (
              <li key={meeting.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <time dateTime={meeting.startsAt} className="shrink-0 pt-0.5 text-md font-semibold tabular-nums" dir="ltr">
                    {zoneTime(new Date(meeting.startsAt), timeZone)}
                  </time>
                  <div className="min-w-0">
                    <p className="break-words font-medium">{meeting.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
                      <span>{MEETING_TYPE_LABEL[meeting.type] ?? meeting.type}</span>
                      {meeting.location ? <bdi className="break-words">{meeting.location}</bdi> : null}
                    </p>
                    {person && name ? (
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span>עם</span>
                        <Link href={recordPage(person.kind, orgId, person.id)} className="break-words text-accent-strong underline-offset-4 hover:underline">
                          <bdi>{name}</bdi>
                          <span className="sr-only"> ({PERSON_LINK_LABEL[person.kind]})</span>
                        </Link>
                        {person.phone ? (
                          <span className="text-ink-soft" dir="ltr">
                            {person.phone}
                          </span>
                        ) : null}
                        {meeting.messagedToday ? <Badge tone="success">נשלחה היום הודעת WhatsApp</Badge> : null}
                      </p>
                    ) : null}
                    {reason ? <p className="mt-1 text-sm text-ink-soft">{reason}</p> : null}
                  </div>
                </div>

                {person && name && !reason ? (
                  <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                    {context.canWrite && person.phoneE164 ? (
                      <WhatsappButton
                        phoneE164={person.phoneE164}
                        orgId={orgId}
                        subject={{ kind: person.kind, id: person.id }}
                        name={name}
                        values={reminderValues(person, meeting, values, tomorrow)}
                        preselectId={templateId}
                      />
                    ) : (
                      <a href={whatsappUrl(person.phoneE164) ?? undefined} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
                        <ChatIcon className="size-4.5 text-accent" />
                        <span dir="ltr">WhatsApp</span>
                        <span className="sr-only">(נפתח בחלון חדש)</span>
                      </a>
                    )}
                    {tel ? (
                      <a href={tel} className={buttonClasses("secondary", "sm")}>
                        <PhoneIcon className="size-4.5 text-accent" />
                        חיוג
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
