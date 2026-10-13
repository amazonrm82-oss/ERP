"use client";

import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { longDay } from "@/lib/calendar-grid";

import { addLeaveAction, removeLeaveAction } from "../actions";
import type { LeaveItem } from "../queries";

type Props = {
  orgId: string;
  userId: string;
  leaves: LeaveItem[];
  canEdit: boolean;
  // the person's "today", for the date fields
  today: string;
  timeZone: string;
};

function rangeText(leave: LeaveItem): string {
  return leave.startsOn === leave.endsOn ? longDay(leave.startsOn) : `${longDay(leave.startsOn)} עד ${longDay(leave.endsOn)}`;
}

/** Current and coming leaves of a member, with adding and removing (CAP-09). */
export function LeaveManager({ orgId, userId, leaves, canEdit, today, timeZone }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addLeaveAction.bind(null, orgId, userId), null);
  const failed = state && !state.ok ? state : null;
  return (
    <div className="space-y-4">
      {leaves.length === 0 ? (
        <p className="text-sm text-ink-soft">אין חופשות קרובות.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {leaves.map((leave) => (
            <li key={leave.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="text-md">
                {rangeText(leave)}
                {leave.startsOn <= today && leave.endsOn >= today ? <span className="ms-2 text-sm text-ink-soft">(עכשיו)</span> : null}
              </span>
              {canEdit ? (
                <ConfirmButton
                  title="למחוק את החופשה?"
                  description={`${rangeText(leave)}. לידים בסבב יגיעו שוב בימים האלה.`}
                  confirmLabel="מחיקת החופשה"
                  action={removeLeaveAction.bind(null, orgId, userId, leave.id)}
                >
                  מחיקה
                  <span className="sr-only">: {rangeText(leave)}</span>
                </ConfirmButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        // a key per saved state: the date fields start empty again after a save
        <form key={state?.ok ? leaves.length : "form"} action={formAction} className="space-y-3" noValidate>
          <FormNotice message={state?.ok ? state.message : null} />
          <FormError message={failed && !failed.fieldErrors ? failed.message : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <DateField
              label="מיום"
              name="starts_on"
              required
              min={today}
              timeZone={timeZone}
              defaultValue={failed?.values?.starts_on ?? ""}
              error={failed?.fieldErrors?.starts_on}
            />
            <DateField
              label="עד יום (כולל)"
              name="ends_on"
              min={today}
              timeZone={timeZone}
              hint="ליום אחד אפשר להשאיר ריק."
              defaultValue={failed?.values?.ends_on ?? ""}
              error={failed?.fieldErrors?.ends_on}
            />
          </div>
          <SubmitButton pending={pending} pendingText="שומרים…" variant="secondary">
            הוספת חופשה
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
