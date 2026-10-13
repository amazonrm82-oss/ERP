"use client";

import { useActionState } from "react";

import { DateField } from "@/components/ui/date-picker";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { addDays } from "@/lib/calendar-grid";
import { formatDate } from "@/lib/format";

import { snoozeDealAction } from "../actions";
import { MAX_SNOOZE_DAYS } from "../snooze";

type Props = {
  orgId: string;
  dealId: string;
  // the stored day, or null; shown as "postponed" only while it is after today
  snoozedUntil: string | null;
  snoozed: boolean;
  today: string;
  timeZone: string;
};

/**
 * Postpone an open deal to a day: it is not marked stuck before then (owner's decision,
 * 13 October 2026). Minimal on purpose; the weekly cleanup (MNY-05) will offer it too.
 */
export function DealSnoozeForm({ orgId, dealId, snoozedUntil, snoozed, today, timeZone }: Props) {
  const [setState, setAction] = useActionState<FormState, FormData>(snoozeDealAction.bind(null, orgId, dealId), null);
  const [clearState, clearAction] = useActionState<FormState, FormData>(snoozeDealAction.bind(null, orgId, dealId), null);
  const errors = setState && !setState.ok ? (setState.fieldErrors ?? {}) : {};

  return (
    <div className="mt-4 space-y-2 border-t border-line pt-3">
      {snoozed && snoozedUntil ? (
        <form action={clearAction} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-soft">
            נדחתה עד <time dateTime={snoozedUntil}>{formatDate(snoozedUntil)}</time>. עד אז היא לא תסומן כתקועה.
          </span>
          <input type="hidden" name="clear" value="1" />
          <SubmitButton size="sm" variant="ghost" pendingText="מבטלים…">
            לבטל דחייה
          </SubmitButton>
          <FormError message={clearState && !clearState.ok ? clearState.message : null} />
        </form>
      ) : null}
      <form action={setAction} className="flex flex-wrap items-end gap-2">
        <DateField
          className="min-w-0 flex-1 basis-40"
          label={snoozed ? "לדחות ליום אחר" : "לדחות עד"}
          name="snoozed_until"
          defaultValue={setState && !setState.ok ? (setState.values?.snoozed_until ?? "") : ""}
          min={addDays(today, 1)}
          max={addDays(today, MAX_SNOOZE_DAYS)}
          timeZone={timeZone}
          hint="עד היום הזה העסקה לא תסומן כתקועה."
          required
          error={errors.snoozed_until}
        />
        <SubmitButton size="sm" variant="secondary" pendingText="שומרים…">
          לדחות
        </SubmitButton>
      </form>
      <FormError message={setState && !setState.ok && !setState.fieldErrors ? setState.message : null} />
    </div>
  );
}
