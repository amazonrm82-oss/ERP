"use client";

import { useActionState, useState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { longDay } from "@/lib/calendar-grid";

import { addLeaveAction, removeLeaveAction } from "../actions";
import { absenceLabel } from "../leave";
import type { LeaveItem } from "../queries";

type Props = {
  orgId: string;
  userId: string;
  leaves: LeaveItem[];
  canEdit: boolean;
  // the person's "today", for the date fields
  today: string;
  timeZone: string;
  // HEB-08: who may stand in (active members who are not viewers, the person left out)
  deputyOptions: { userId: string; name: string }[];
  // HEB-08: the forms whose leads go to this member as their fixed owner (read by owners/admins only), and the member's name
  fixedOwnerForms: string[];
  personName: string;
};

function rangeText(leave: LeaveItem): string {
  return leave.startsOn === leave.endsOn ? longDay(leave.startsOn) : `${longDay(leave.startsOn)} עד ${longDay(leave.endsOn)}`;
}

/** Current and coming leaves of a member, with adding and removing (CAP-09); kind and deputy (HEB-08). */
export function LeaveManager({ orgId, userId, leaves, canEdit, today, timeZone, deputyOptions, fixedOwnerForms, personName }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addLeaveAction.bind(null, orgId, userId), null);
  const failed = state && !state.ok ? state : null;
  const [deputy, setDeputy] = useState<string>(failed?.values?.deputy_id ?? "");
  return (
    <div className="space-y-4">
      {leaves.length === 0 ? (
        <p className="text-sm text-ink-soft">אין חופשות קרובות.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {leaves.map((leave) => (
            <li key={leave.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="block text-md">
                  {leave.kind ? `${absenceLabel(leave.kind)}: ` : null}
                  {rangeText(leave)}
                  {leave.startsOn <= today && leave.endsOn >= today ? <span className="ms-2 text-sm text-ink-soft">(עכשיו)</span> : null}
                </span>
                {leave.deputyId ? <span className="block text-sm text-ink-soft">ממלא מקום: {leave.deputyName ?? "משתמש"}</span> : null}
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
            <SelectField label="סוג ההיעדרות" name="kind" defaultValue={failed?.values?.kind ?? "vacation"}>
              <option value="vacation">בחופשה</option>
              <option value="reserve">במילואים</option>
              <option value="other">היעדרות אחרת</option>
            </SelectField>
            <SelectField
              label="ממלא מקום"
              name="deputy_id"
              hint="לידים חדשים יגיעו אליו, והוא יראה את המשימות הפתוחות. המשימות נשארות על שם הנעדר."
              value={deputy}
              onChange={(event) => setDeputy(event.target.value)}
              error={failed?.fieldErrors?.deputy_id}
            >
              <option value="">בלי ממלא מקום</option>
              {deputyOptions.map((option) => (
                <option key={option.userId} value={option.userId}>
                  {option.name}
                </option>
              ))}
            </SelectField>
          </div>
          {deputy === "" && fixedOwnerForms.length > 0 ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              {`${fixedOwnerForms.length === 1 ? "הטופס" : "הטפסים"} ${fixedOwnerForms.map((name) => `"${name}"`).join(", ")} ${fixedOwnerForms.length === 1 ? "רשום" : "רשומים"} על שם ${personName}. בזמן ההיעדרות הלידים ייכנסו בלי אחראי. כדאי להגדיר ממלא מקום.`}
            </p>
          ) : null}
          <SubmitButton pending={pending} pendingText="שומרים…" variant="secondary">
            הוספת היעדרות
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
