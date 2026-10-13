"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { closeDealWonAction } from "../actions";
import { amountInputValue, type CloseWindowSetup, ONBOARDING_TITLE_MAX, onboardingDueDate, onboardingTitle } from "../close-window";

// the deal that is about to be won, and the won stage it goes to
export type WonTarget = { dealId: string; dealName: string; stageId: string; stageName: string; amountAgorot: number; ownerId: string | null };

export type { CloseWindowSetup };

type Props = { orgId: string; target: WonTarget | null; setup: CloseWindowSetup; onClose: () => void; onDone?: (target: WonTarget) => void };

/**
 * DEAL-04, the close window on the won side: confirm the amount and the close
 * date, and choose what comes next (wave 1: an onboarding task). Nothing moves
 * until "סגירה בהצלחה" is pressed; closing the window leaves the deal where it was.
 */
export function DealWonDialog({ orgId, target, setup, onClose, onDone }: Props) {
  return (
    <Dialog open={target !== null} onClose={onClose} title="העסקה נסגרה בהצלחה?" description={target ? `${target.dealName} · שלב ${target.stageName}` : undefined} variant="sheet">
      {target ? (
        <WonForm
          key={`${target.dealId}-${target.stageId}`}
          orgId={orgId}
          target={target}
          setup={setup}
          onCancel={onClose}
          onDone={() => {
            onDone?.(target);
            onClose();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function WonForm({ orgId, target, setup, onCancel, onDone }: { orgId: string; target: WonTarget; setup: CloseWindowSetup; onCancel: () => void; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await closeDealWonAction(orgId, target.dealId, target.stageId, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [onboarding, setOnboarding] = useState(values ? values.onboarding === "on" : false);
  const ownerDefault = values?.task_owner_id ?? (target.ownerId && setup.owners.some((o) => o.value === target.ownerId) ? target.ownerId : "");

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <TextField
        label="סכום סופי (₪)"
        name="amount"
        dir="ltr"
        inputMode="decimal"
        autoComplete="off"
        autoFocus
        defaultValue={values?.amount ?? amountInputValue(target.amountAgorot)}
        error={errors.amount}
      />
      <DateField
        label="תאריך סגירה"
        name="closed_date"
        required
        defaultValue={values?.closed_date ?? setup.today}
        max={setup.today}
        timeZone={setup.timeZone}
        error={errors.closed_date}
      />
      <fieldset className="space-y-3 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-medium text-ink">מה הלאה?</legend>
        <Checkbox
          label="משימת קליטה ללקוח"
          hint="משימה שמקושרת לעסקה, כדי שלא ישכחו להתחיל לעבוד עם הלקוח."
          name="onboarding"
          checked={onboarding}
          onChange={(event) => setOnboarding(event.target.checked)}
        />
        {onboarding ? (
          <div className="space-y-3">
            <TextField
              label="מה צריך לעשות"
              name="task_title"
              required
              maxLength={ONBOARDING_TITLE_MAX}
              autoComplete="off"
              defaultValue={values?.task_title ?? onboardingTitle(target.dealName)}
              error={errors.task_title}
            />
            <DateField
              label="עד מתי"
              name="task_due_date"
              defaultValue={values?.task_due_date ?? onboardingDueDate(setup.today)}
              timeZone={setup.timeZone}
              error={errors.task_due_date}
            />
            {setup.owners.length > 0 ? (
              <SelectField label="באחריות" name="task_owner_id" defaultValue={ownerDefault} error={errors.task_owner_id}>
                <option value="">אני</option>
                {setup.owners.map((owner) => (
                  <option key={owner.value} value={owner.value}>
                    {owner.label}
                  </option>
                ))}
              </SelectField>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="סוגרים…">סגירה בהצלחה</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
