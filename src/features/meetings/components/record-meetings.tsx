import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { TimelineSubject } from "@/features/activities/schema";
import { InviteFileLink } from "@/features/calendar-feed/components/invite-file-link";
import { listMeetingTypeChoices } from "@/features/meeting-types/queries";
import { listMembers } from "@/features/settings/queries";
import { zoneDate } from "@/lib/format";

import { formatMeetingWhen, meetingFormTimes, MEETING_STATUS_TONE } from "../display";
import { listRecordMeetings, type MeetingItem } from "../queries";
import { seriesLabel } from "../series";
import { DEFAULT_MEETING_REMINDER, MEETING_STATUS_LABEL, MEETING_TYPE_LABEL, reminderChoice, splitMeetings } from "../schema";
import { MeetingItemButtons, NewMeetingButton } from "./meeting-buttons";
import type { MeetingFormValues, MemberOption } from "./meeting-form";

type Props = {
  orgId: string;
  subject: TimelineSubject;
  canWrite: boolean;
  // the organization's zone: meetings are shown and entered in it
  timeZone: string;
  userId: string;
};

/**
 * The "פגישות" card of a lead, contact, company or deal (CAL-01): the coming
 * meetings first, then the past ones with how they went. On a phone each
 * meeting is a stacked block; forms open as a bottom sheet.
 */
export async function RecordMeetings({ orgId, subject, canWrite, timeZone, userId }: Props) {
  const [meetings, members, meetingTypes] = await Promise.all([
    listRecordMeetings(orgId, subject),
    canWrite ? listMembers(orgId) : Promise.resolve([]),
    listMeetingTypeChoices(orgId),
  ]);
  const typeById = new Map(meetingTypes.map((type) => [type.id, type]));
  const options: MemberOption[] = members
    .filter((member) => member.status === "active")
    .map((member) => ({ userId: member.userId, name: member.userId === userId ? `${member.name} (אני)` : member.name }));
  const { upcoming, past } = splitMeetings(meetings, new Date());

  const blank: MeetingFormValues = {
    title: "",
    meeting_type_id: "",
    meeting_type: "in_person",
    date: zoneDate(new Date(), timeZone),
    start_time: "10:00",
    end_time: "11:00",
    location: "",
    video_url: "",
    description: "",
    participant_ids: [userId],
    reminder_minutes: DEFAULT_MEETING_REMINDER,
    buffer_before_minutes: "0",
    buffer_after_minutes: "0",
  };

  const item = (meeting: MeetingItem) => {
    const meetingType = meeting.meetingTypeId ? typeById.get(meeting.meetingTypeId) : undefined;
    return (
    <li key={meeting.id} className="space-y-1.5 py-3 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 break-words font-medium">{meeting.title}</span>
        <span className="flex flex-wrap gap-1.5">
          {/* CAL-08: the type in its colour, with its name (never colour alone) */}
          {meetingType ? <Badge tone={meetingType.color ?? "neutral"}>{meetingType.name}</Badge> : null}
          <Badge tone={MEETING_STATUS_TONE[meeting.status] ?? "neutral"}>{MEETING_STATUS_LABEL[meeting.status] ?? meeting.status}</Badge>
        </span>
      </div>
      <p className="text-sm text-ink-soft">
        <time dateTime={meeting.startsAt}>{formatMeetingWhen(meeting.startsAt, meeting.endsAt, timeZone)}</time>
        {" · "}
        {MEETING_TYPE_LABEL[meeting.meetingType] ?? meeting.meetingType}
        {meeting.seriesIndex ? ` · ${seriesLabel(meeting.seriesIndex)}` : ""}
      </p>
      {meeting.videoUrl ? (
        <p className="text-sm">
          <a
            href={meeting.videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong"
          >
            כניסה לשיחת הווידאו
          </a>
        </p>
      ) : null}
      {meeting.location ? <p className="break-words text-sm text-ink-soft">{meeting.location}</p> : null}
      {meeting.participants.length > 0 ? (
        <p className="text-sm text-ink-soft">משתתפים: {meeting.participants.map((p) => p.name).join(", ")}</p>
      ) : null}
      {meeting.description ? <p className="whitespace-pre-line break-words text-sm">{meeting.description}</p> : null}
      {meeting.outcome ? (
        <p className="whitespace-pre-line break-words rounded-md bg-canvas px-3 py-2 text-sm">
          <span className="font-medium">תוצאה: </span>
          {meeting.outcome}
        </p>
      ) : null}
      {canWrite ? (
        <MeetingItemButtons
          orgId={orgId}
          subject={subject}
          members={options}
          meetingTypes={meetingTypes}
          timeZone={timeZone}
          meetingId={meeting.id}
          title={meeting.title}
          status={meeting.status}
          outcome={meeting.outcome ?? ""}
          initial={{
            title: meeting.title,
            meeting_type_id: meeting.meetingTypeId ?? "",
            series_index: meeting.seriesIndex,
            meeting_type: meeting.meetingType,
            ...meetingFormTimes(meeting.startsAt, meeting.endsAt, timeZone),
            location: meeting.location ?? "",
            video_url: meeting.videoUrl ?? "",
            description: meeting.description ?? "",
            participant_ids: meeting.participants.map((p) => p.userId),
            reminder_minutes: reminderChoice(meeting.reminderMinutes),
            buffer_before_minutes: String(meeting.bufferBefore),
            buffer_after_minutes: String(meeting.bufferAfter),
          }}
        />
      ) : null}
      <InviteFileLink orgId={orgId} meetingId={meeting.id} title={meeting.title} />
    </li>
    );
  };

  return (
    <Card aria-labelledby="record-meetings-title">
      <CardHeader id="record-meetings-title" title={meetings.length > 0 ? `פגישות (${meetings.length})` : "פגישות"} />
      <CardBody className="space-y-4">
        {canWrite ? <NewMeetingButton orgId={orgId} subject={subject} members={options} meetingTypes={meetingTypes} timeZone={timeZone} initial={blank} /> : null}
        {meetings.length === 0 ? <p className="text-md text-ink-soft">אין עדיין פגישות עם הרשומה הזו.</p> : null}
        {upcoming.length > 0 ? (
          <section aria-labelledby="meetings-upcoming">
            <h3 id="meetings-upcoming" className="text-sm font-semibold text-ink-soft">
              קרובות
            </h3>
            <ul className="divide-y divide-line">{upcoming.map(item)}</ul>
          </section>
        ) : null}
        {past.length > 0 ? (
          <section aria-labelledby="meetings-past">
            <h3 id="meetings-past" className="text-sm font-semibold text-ink-soft">
              קודמות
            </h3>
            <ul className="divide-y divide-line">{past.map(item)}</ul>
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}
