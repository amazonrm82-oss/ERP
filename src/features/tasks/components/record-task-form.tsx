"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import type { TimelineSubject } from "@/features/activities/schema";
import type { FormState } from "@/lib/action-result";

import { addRecordTaskAction } from "../actions";

/**
 * One line and three buttons: add a task to this record, for later, tomorrow or in a week (FXU-01).
 * A day the business does not work becomes the next working day, and the notice says which (HEB-02).
 */
export function RecordTaskForm({ orgId, subject }: { orgId: string; subject: TimelineSubject }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addRecordTaskAction.bind(null, orgId, subject), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-2">
      <TextField
        label="משימה חדשה לרשומה הזו"
        hideLabel
        name="title"
        maxLength={300}
        placeholder="למשל: להתקשר עם הצעת מחיר"
        defaultValue={failure?.values?.title}
        error={failure?.fieldErrors?.title}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="when" value="tomorrow" size="sm" disabled={pending}>
          מחר
        </Button>
        <Button type="submit" name="when" value="week" size="sm" variant="secondary" disabled={pending}>
          בעוד שבוע
        </Button>
        <Button type="submit" name="when" value="none" size="sm" variant="ghost" disabled={pending}>
          בלי תאריך
        </Button>
      </div>
      {failure && !failure.fieldErrors ? <FormError message={failure.message} /> : null}
      <FormNotice message={state?.ok ? (state.message ?? "המשימה נוספה.") : null} />
    </form>
  );
}
