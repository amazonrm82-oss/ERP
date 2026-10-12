"use client";

import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { TimelineSubject } from "@/features/activities/schema";

import { createMeetingAction, updateMeetingAction, type MeetingFormState } from "../actions";
import { MEETING_TYPE_OPTIONS } from "../schema";
import { ConflictWarning } from "./conflict-warning";

export type MemberOption = { userId: string; name: string };

export type MeetingFormValues = {
  title: string;
  meeting_type: string;
  date: string;
  start_time: string;
  end_time: string;
  location: string;
  video_url: string;
  description: string;
  participant_ids: string[];
};

type Props = {
  orgId: string;
  // the record the meeting is on; null when it is edited from the calendar (no record page to refresh)
  subject: TimelineSubject | null;
  // absent: a new meeting
  meetingId?: string;
  initial: MeetingFormValues;
  members: MemberOption[];
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
export function MeetingForm({ orgId, subject, meetingId, initial, members, timeZone, onDone, onCancel }: Props) {
  const action = meetingId ? updateMeetingAction.bind(null, orgId, meetingId, subject) : createMeetingAction.bind(null, orgId, subject);
  const [state, formAction] = useActionState<MeetingFormState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;
  const participantIds = failure?.participantIds ?? initial.participant_ids;
  // CAL-05: the conflict warning holds until the user changes something in the form
  const [changedAfter, setChangedAfter] = useState<MeetingFormState>(null);
  const conflict = failure?.conflicts && failure.span && changedAfter !== state ? { report: failure.conflicts, span: failure.span } : null;

  const [type, setType] = useState(values?.meeting_type ?? initial.meeting_type);
  const [start, setStart] = useState(values?.start_time ?? initial.start_time);
  const [end, setEnd] = useState(values?.end_time ?? initial.end_time);

  useEffect(() => {
    if (state?.ok) onDone(state.message);
  }, [state, onDone]);

  return (
    <form action={formAction} onChange={() => setChangedAfter(state)} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors && !failure.conflicts ? failure.message : null} />
      <TextField
        label="כותרת"
        name="title"
        required
        maxLength={300}
        autoComplete="off"
        placeholder="למשל: פגישת היכרות"
        defaultValue={values?.title ?? initial.title}
        error={errors.title}
      />
      <SelectField label="סוג" name="meeting_type" value={type} onChange={(event) => setType(event.target.value)} error={errors.meeting_type}>
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
        defaultValue={values?.date ?? initial.date}
        timeZone={timeZone}
        error={errors.date}
        onChange={() => setChangedAfter(state)}
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
            // keep the end after the start, an hour later by default
            if (next && end <= next) setEnd(anHourLater(next));
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
            defaultValue={values?.location ?? initial.location}
            error={errors.location}
          />
      )}
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
      {conflict ? (
        <ConflictWarning report={conflict.report} span={conflict.span} timeZone={timeZone}>
          <SubmitButton name="conflicts_ok" value="1" size="sm" pendingText="שומרים…">
            {meetingId ? "לשמור בכל זאת" : "לקבוע בכל זאת"}
          </SubmitButton>
        </ConflictWarning>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {/* while the warning shows, saving goes through its button; changing the form brings this one back */}
        {conflict ? null : <SubmitButton pendingText="שומרים…">{meetingId ? "שמירת השינויים" : "קביעת הפגישה"}</SubmitButton>}
        <Button variant="ghost" onClick={() => (onCancel ? onCancel() : onDone())}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
