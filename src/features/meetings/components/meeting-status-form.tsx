"use client";

import { useActionState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { TimelineSubject } from "@/features/activities/schema";
import type { FormState } from "@/lib/action-result";

import { setMeetingStatusAction } from "../actions";
import { MEETING_STATUS_OPTIONS } from "../schema";

type Props = { orgId: string; meetingId: string; subject: TimelineSubject | null; status: string; outcome: string; onDone: () => void; onCancel?: () => void };

/** How the meeting went: held, cancelled or the customer did not come, and what came of it. */
export function MeetingStatusForm({ orgId, meetingId, subject, status, outcome, onDone, onCancel }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(setMeetingStatusAction.bind(null, orgId, meetingId, subject), null);
  const failure = state && !state.ok ? state : null;
  const current = failure?.values?.status ?? status;

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">סטטוס</legend>
        <div className="grid grid-cols-2 gap-2">
          {MEETING_STATUS_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 has-checked:border-accent has-checked:bg-accent-soft"
            >
              <input type="radio" name="status" value={option.value} defaultChecked={current === option.value} required />
              {option.label}
            </label>
          ))}
        </div>
        {failure?.fieldErrors?.status ? <p className="mt-1 text-sm text-danger">{failure.fieldErrors.status}</p> : null}
      </fieldset>
      <TextareaField
        label="תוצאה (לא חובה)"
        name="outcome"
        rows={3}
        maxLength={5000}
        placeholder="מה סוכם, ומה הצעד הבא"
        defaultValue={failure?.values?.outcome ?? outcome}
        error={failure?.fieldErrors?.outcome}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">שמירה</SubmitButton>
        <Button variant="ghost" onClick={() => (onCancel ?? onDone)()}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
