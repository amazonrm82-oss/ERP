"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { Weekday, WorkingHours } from "@/features/profile/working-hours";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { saveOrgHoursAction } from "../actions";
import { HoursFields } from "./hours-fields";

type Props = {
  orgId: string;
  // the business's saved hours
  hours: WorkingHours;
  // "יום מנוחה" next to the weekly rest days
  restNotes: Partial<Record<Weekday, string>>;
};

/** The business's weekly hours (CAP-09), for owners and admins. */
export function OrgHoursForm({ orgId, hours, restNotes }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveOrgHoursAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  return (
    <form onSubmit={submitWith(formAction)} className="space-y-4" noValidate>
      <FormNotice message={state?.ok ? state.message : null} />
      {failed && !failed.fieldErrors?.working_hours ? <FormError message={failed.message} /> : null}
      <HoursFields
        legend="שעות העבודה של העסק"
        hint={"לידים בסבב מגיעים רק למי שבשעות העבודה שלו ולא בחופשה. מי שלא הגדיר שעות משלו עובד לפי השעות האלה. בימי המנוחה ובחגים העסק סגור, גם אם מסומנות בהם שעות. ליד שמגיע כשאף אחד בסבב לא בשעות העבודה מחכה בלי אחראי, והצוות מקבל התראה עם \"לקחתי\"; אם אף אחד לא לקח, הוא עובר בסבב לראשון שחוזר לשעות העבודה."}
        initial={hours}
        dayRange={{ start: "08:00", end: "18:00" }}
        dayNotes={restNotes}
        error={failed?.fieldErrors?.working_hours}
      />
      <SubmitButton pending={pending} pendingText="שומרים…">
        שמירת שעות העבודה
      </SubmitButton>
    </form>
  );
}
