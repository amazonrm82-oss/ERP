"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { savePunchReportDaysAction } from "../punch-days-actions";
import { PUNCH_DAYS_CHOICES, type PunchDays } from "../punch-days";

/** PKG-07 (owner (117) ב): the punch cards report's "expiring" window, kept for this user and business. */
export function PunchDaysForm({ orgId, days }: { orgId: string; days: PunchDays }) {
  const [state, formAction] = useActionState<FormState, FormData>(savePunchReportDaysAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4" aria-label="סינון הדוח">
      <SelectField label="פגות בתוך" name="days" defaultValue={String(days)} className="w-44">
        {PUNCH_DAYS_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {choice} יום
          </option>
        ))}
      </SelectField>
      <SubmitButton pendingText="מציגים…">הצגה</SubmitButton>
      <FormError message={failed?.message ?? null} className="basis-full" />
    </form>
  );
}
