"use client";

import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { TimelineSubject } from "@/features/activities/schema";
import { durationText, fillFromType, offeredTypes, timeAfter, type MeetingTypeChoice } from "@/features/meeting-types/schema";
import { longDay } from "@/lib/calendar-grid";

import { createMeetingAction, updateMeetingAction, type MeetingFormState } from "../actions";
import { MEETING_REMINDER_OPTIONS, MEETING_TYPE_OPTIONS, type MeetingReminderValue } from "../schema";
import { DEFAULT_SERIES_COUNT, lastSeriesDate, SERIES_MAX, SERIES_MIN, seriesLabel } from "../series";
import { ConflictWarning } from "./conflict-warning";

export type MemberOption = { userId: string; name: string };

export type MeetingFormValues = {
  title: string;
  // CAL-08: the business's meeting type, "" = none
  meeting_type_id: string;
  meeting_type: string;
  date: string;
  start_time: string;
  end_time: string;
  location: string;
  video_url: string;
  description: string;
  participant_ids: string[];
  // CAL-06: "none" or minutes before the start
  reminder_minutes: MeetingReminderValue;
  // CAL-09: the meeting's place in its weekly series; absent or null = a single meeting
  series_index?: number | null;
};

type Props = {
  orgId: string;
  // the record the meeting is on; null when it is edited from the calendar (no record page to refresh)
  subject: TimelineSubject | null;
  // absent: a new meeting
  meetingId?: string;
  initial: MeetingFormValues;
  members: MemberOption[];
  // CAL-08: the organization's meeting types (the form offers the active ones and the meeting's own)
  meetingTypes?: MeetingTypeChoice[];
  timeZone: string;
  // message: the meeting was saved but something next to it was not (participants)
  onDone: (message?: string) => void;
  // "ביטול"; without it, onDone() is called
  onCancel?: () => void;
};

/** One hour after "HH:MM", capped at 23:59 (a meeting in the form stays on one day). */
function anHourLater(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  return h >= 23 ? "23:59" : `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** New or edited meeting (CAL-01): what, when, where, who comes. */
export function MeetingForm({ orgId, subject, meetingId, initial, members, meetingTypes = [], timeZone, onDone, onCancel }: Props) {
  const action = meetingId ? updateMeetingAction.bind(null, orgId, meetingId, subject) : createMeetingAction.bind(null, orgId, subject);
  const [state, formAction] = useActionState<MeetingFormState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;
  const participantIds = failure?.participantIds ?? initial.participant_ids;
  // CAL-05: the conflict warning holds until the user changes something in the form
  const [changedAfter, setChangedAfter] = useState<MeetingFormState>(null);
  const conflict = failure?.conflicts && failure.span && changedAfter !== state ? { report: failure.conflicts, span: failure.span } : null;
  // CAL-09: moving "this and following" to another weekday asks first, with the new series' warnings
  const split = failure?.split && changedAfter !== state ? failure.split : null;

  const [type, setType] = useState(values?.meeting_type ?? initial.meeting_type);
  const [start, setStart] = useState(values?.start_time ?? initial.start_time);
  const [end, setEnd] = useState(values?.end_time ?? initial.end_time);
  const [title, setTitle] = useState(values?.title ?? initial.title);
  const [location, setLocation] = useState(values?.location ?? initial.location);
  const [typeId, setTypeId] = useState(values?.meeting_type_id ?? initial.meeting_type_id);
  const types = offeredTypes(meetingTypes, initial.meeting_type_id);
  const typeOf = (id: string) => types.find((t) => t.id === id) ?? null;

  /** CAL-08: a picked type fills the end (its duration), the format, and an untouched title and location. */
  function pickType(nextId: string) {
    const filled = fillFromType(typeOf(typeId), typeOf(nextId), { title, format: type, location, startTime: start, endTime: end });
    setTypeId(nextId);
    setTitle(filled.title);
    setType(filled.format);
    setLocation(filled.location);
    setEnd(filled.endTime);
  }
  const picked = typeOf(typeId);
  // CAL-09: a new meeting may repeat every week; a series meeting asks what an edit applies to
  const [date, setDate] = useState(values?.date ?? initial.date);
  const [repeat, setRepeat] = useState(values?.repeat === "weekly");
  const [count, setCount] = useState(values?.series_count ?? String(DEFAULT_SERIES_COUNT));
  const seriesIndex = meetingId ? (initial.series_index ?? null) : null;
  const countNumber = Number(count);
  const until = repeat && /^\d+$/.test(count) && countNumber >= SERIES_MIN && countNumber <= SERIES_MAX && date ? lastSeriesDate(date, countNumber) : null;

  useEffect(() => {
    if (state?.ok) onDone(state.message);
  }, [state, onDone]);

  return (
    <form action={formAction} onChange={() => setChangedAfter(state)} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors && !failure.conflicts && !failure.split ? failure.message : null} />
      {types.length > 0 ? (
        <SelectField
          label="סוג פגישה"
          name="meeting_type_id"
          value={typeId}
          onChange={(event) => pickType(event.target.value)}
          hint={picked ? `${durationText(picked.durationMinutes)}. המשך, המיקום ואופן הפגישה מתמלאים לבד, ואפשר לשנות.` : undefined}
          error={errors.meeting_type_id}
        >
          <option value="">בלי סוג</option>
          {types.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </SelectField>
      ) : (
        <input type="hidden" name="meeting_type_id" value={typeId} />
      )}
      <TextField
        label="כותרת"
        name="title"
        required
        maxLength={300}
        autoComplete="off"
        placeholder="למשל: פגישת היכרות"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        error={errors.title}
      />
      <SelectField label="אופן הפגישה" name="meeting_type" value={type} onChange={(event) => setType(event.target.value)} error={errors.meeting_type}>
        {MEETING_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <DateField
        label="תאריך"
        name="date"
        required
        value={date}
        timeZone={timeZone}
        error={errors.date}
        onChange={(day) => {
          setDate(day);
          setChangedAfter(state);
        }}
      />
      <div className="grid grid-cols-2 gap-4">
        <TextField
          label="משעה"
          name="start_time"
          type="time"
          required
          value={start}
          onChange={(event) => {
            const next = event.target.value;
            setStart(next);
            // keep the end after the start: the type's duration later, else an hour later
            if (next && end <= next) setEnd(picked ? timeAfter(next, picked.durationMinutes) : anHourLater(next));
          }}
          error={errors.start_time}
        />
        <TextField label="עד שעה" name="end_time" type="time" required value={end} onChange={(event) => setEnd(event.target.value)} error={errors.end_time} />
      </div>
      {type === "video" ? (
        <TextField
          label="קישור לשיחת הווידאו"
          name="video_url"
          type="url"
          inputMode="url"
          dir="ltr"
          maxLength={2000}
          placeholder="https://"
          defaultValue={values?.video_url ?? initial.video_url}
          error={errors.video_url}
        />
      ) : (
        <TextField
            label={type === "phone" ? "מספר או הערה לשיחה (לא חובה)" : "מיקום (לא חובה)"}
            name="location"
            maxLength={500}
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            error={errors.location}
          />
      )}
      <SelectField
        label="תזכורת לצוות"
        name="reminder_minutes"
        defaultValue={values?.reminder_minutes ?? initial.reminder_minutes}
        hint="למארגן ולמשתתפים, בפעמון ובהתראה לטלפון."
        error={errors.reminder_minutes}
      >
        {MEETING_REMINDER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      {meetingId ? null : (
        <div className="space-y-3 rounded-md border border-line p-3">
          <Checkbox
            name="repeat"
            value="weekly"
            label="פגישה חוזרת כל שבוע"
            hint="למשל סדרת טיפולים. כל הפגישות נקבעות עכשיו, באותו יום בשבוע ובאותה שעה."
            checked={repeat}
            onChange={(event) => setRepeat(event.target.checked)}
          />
          {repeat ? (
            <TextField
              label="כמה פגישות בסך הכול"
              name="series_count"
              type="number"
              inputMode="numeric"
              min={SERIES_MIN}
              max={SERIES_MAX}
              required
              value={count}
              onChange={(event) => setCount(event.target.value)}
              hint={until ? `הפגישה האחרונה: ${longDay(until)}` : `בין ${SERIES_MIN} ל-${SERIES_MAX}.`}
              error={errors.series_count}
            />
          ) : null}
        </div>
      )}
      {seriesIndex ? (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{seriesLabel(seriesIndex)}. לשמור את השינויים ל:</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 has-checked:border-accent has-checked:bg-accent-soft">
              <input type="radio" name="series_scope" value="one" defaultChecked={values?.series_scope !== "following"} />
              הפגישה הזו בלבד
            </label>
            <label className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 has-checked:border-accent has-checked:bg-accent-soft">
              <input type="radio" name="series_scope" value="following" defaultChecked={values?.series_scope === "following"} />
              הפגישה הזו וכל הבאות
            </label>
          </div>
          <p className="mt-1.5 text-sm text-ink-soft">
            לפגישות הבאות עוברים הפרטים והשעה, וכל אחת נשארת ביום שלה. בחירת יום אחר בשבוע מעבירה את כל הבאות ליום החדש, כסדרה חדשה. פגישות
            שכבר עברו, התקיימו או בוטלו לא משתנות.
          </p>
        </fieldset>
      ) : null}
      {members.length > 0 ? (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">משתתפים מהצוות</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {members.map((member) => (
              <Checkbox
                key={member.userId}
                name="participant_ids"
                value={member.userId}
                label={member.name}
                defaultChecked={participantIds.includes(member.userId)}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      <TextareaField
        label="תיאור (לא חובה)"
        name="description"
        rows={3}
        maxLength={5000}
        defaultValue={values?.description ?? initial.description}
        error={errors.description}
      />
      {split ? (
        <div role="alert" className="space-y-2.5 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-warning">
          <p className="font-semibold">{split.text}</p>
          {conflict ? <ConflictWarning report={conflict.report} span={conflict.span} timeZone={timeZone} /> : null}
          <SubmitButton name="split_ok" value="1" size="sm" pendingText="מעבירים…">
            להעביר את הסדרה
          </SubmitButton>
        </div>
      ) : conflict ? (
        <ConflictWarning report={conflict.report} span={conflict.span} timeZone={timeZone}>
          <SubmitButton name="conflicts_ok" value="1" size="sm" pendingText="שומרים…">
            {meetingId ? "לשמור בכל זאת" : "לקבוע בכל זאת"}
          </SubmitButton>
        </ConflictWarning>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {/* while the warning shows, saving goes through its button; changing the form brings this one back */}
        {conflict || split ? null : <SubmitButton pendingText="שומרים…">{meetingId ? "שמירת השינויים" : repeat ? "קביעת הסדרה" : "קביעת הפגישה"}</SubmitButton>}
        <Button variant="ghost" onClick={() => (onCancel ? onCancel() : onDone())}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
