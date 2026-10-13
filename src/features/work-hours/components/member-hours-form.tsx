"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { WorkingHours } from "@/features/profile/working-hours";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { saveMemberHoursAction } from "../actions";
import { HoursFields } from "./hours-fields";

type Props = {
  orgId: string;
  userId: string;
  // "שלכם" on the user's own page, the name on an admin's
  whose: string | null;
  // null: the business's hours apply
  hours: WorkingHours | null;
  // the business's hours on its working days (or 08:00-18:00 there): where "own hours" start from
  orgHours: WorkingHours;
  // false: the business set no hours, so "like the business" means no limit
  orgHasHours: boolean;
  // the zone the person's own hours are read in, as text
  zoneText: string;
};

/** A member's weekly hours: the business's, or their own (CAP-09). */
export function MemberHoursForm({ orgId, userId, whose, hours, orgHours, orgHasHours, zoneText }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveMemberHoursAction.bind(null, orgId, userId), null);
  const failed = state && !state.ok ? state : null;
  const [mode, setMode] = useState<"org" | "own">(hours ? "own" : "org");
  const name = `hours-mode-${userId}`;
  return (
    <form onSubmit={submitWith(formAction)} className="space-y-4" noValidate>
      <FormNotice message={state?.ok ? state.message : null} />
      {failed && !failed.fieldErrors?.working_hours ? <FormError message={failed.message} /> : null}
      <fieldset>
        <legend className="text-md font-medium text-ink">{whose ? `שעות העבודה של ${whose}` : "שעות העבודה שלי"}</legend>
        <div className="mt-2 flex flex-col gap-1">
          <label className="flex min-h-11 items-center gap-2 text-md">
            <input
              type="radio"
              name="mode"
              value="org"
              checked={mode === "org"}
              onChange={() => setMode("org")}
              aria-describedby={`${name}-org`}
              className="size-5 shrink-0 accent-[var(--color-accent)]"
            />
            כמו שעות העסק
          </label>
          <p id={`${name}-org`} className="ms-7 text-sm text-ink-soft">
            {orgHasHours ? "אם העסק ישנה את השעות, השינוי יחול גם כאן." : "לעסק לא הוגדרו שעות, ולכן לידים בסבב מגיעים בכל שעה."}
          </p>
          <label className="flex min-h-11 items-center gap-2 text-md">
            <input
              type="radio"
              name="mode"
              value="own"
              checked={mode === "own"}
              onChange={() => setMode("own")}
              className="size-5 shrink-0 accent-[var(--color-accent)]"
            />
            שעות אחרות
          </label>
          <p className="ms-7 text-sm text-ink-soft">
            השעות האלה קובעות גם מתי יגיעו לידים בסבב, גם כשלעסק לא הוגדרו שעות.
          </p>
        </div>
      </fieldset>
      {mode === "own" ? (
        <HoursFields
          legend="ימים ושעות"
          hint={`לפי אזור הזמן ${zoneText}. אפשר לפצל יום לעד 3 טווחים. בימי המנוחה ובחגים של העסק לא מגיעים לידים.`}
          initial={hours ?? orgHours}
          dayRange={{ start: "09:00", end: "17:00" }}
          error={failed?.fieldErrors?.working_hours}
        />
      ) : null}
      <SubmitButton pending={pending} pendingText="שומרים…">
        שמירת שעות העבודה
      </SubmitButton>
    </form>
  );
}
