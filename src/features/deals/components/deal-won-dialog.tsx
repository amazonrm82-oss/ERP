"use client";

import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { closeDealWonAction, dealOnboardingTaskAction } from "../actions";
import {
  amountInputValue,
  type CloseWindowSetup,
  ONBOARDING_EXISTS,
  ONBOARDING_TITLE_MAX,
  onboardingChoiceFromStored,
  onboardingChoiceKey,
  onboardingTitle,
  storedOnboardingChoice,
} from "../close-window";
import { OldCloseDateQuestion, useOldCloseDate } from "./old-close-date";

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

// the user's last choice on this device (per user and organization); checked when unknown
function readChoice(key: string): boolean {
  try {
    return onboardingChoiceFromStored(window.localStorage.getItem(key));
  } catch {
    return true;
  }
}

function rememberChoice(key: string, checked: boolean) {
  try {
    window.localStorage.setItem(key, storedOnboardingChoice(checked));
  } catch {
    // private mode or blocked storage: the window just starts checked next time
  }
}

function WonForm({ orgId, target, setup, onCancel, onDone }: { orgId: string; target: WonTarget; setup: CloseWindowSetup; onCancel: () => void; onDone: () => void }) {
  const choiceKey = onboardingChoiceKey(orgId, setup.userId);
  // an open onboarding task already linked to the deal: none is offered (checked again on save)
  const [existing, setExisting] = useState<"checking" | "open" | "none">("checking");
  useEffect(() => {
    let cancelled = false;
    dealOnboardingTaskAction(orgId, target.dealId)
      .then((result) => {
        if (!cancelled) setExisting(result.ok && result.data?.open ? "open" : "none");
      })
      .catch(() => {
        if (!cancelled) setExisting("none");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, target.dealId]);

  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await closeDealWonAction(orgId, target.dealId, target.stageId, prev, formData);
    if (result?.ok) {
      if (existing !== "open") rememberChoice(choiceKey, formData.get("onboarding") === "on");
      onDone();
    }
    return result;
  }, null);
  // a close date more than three months back is confirmed first
  const { onSubmit, asking, confirm, cancel } = useOldCloseDate(setup.today);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [onboarding, setOnboarding] = useState(() => (values ? values.onboarding === "on" : readChoice(choiceKey)));
  const ownerDefault = values?.task_owner_id ?? (target.ownerId && setup.owners.some((o) => o.value === target.ownerId) ? target.ownerId : "");

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-4" noValidate>
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
        {existing === "open" ? (
          <p className="text-sm text-ink-soft">{ONBOARDING_EXISTS}</p>
        ) : (
          <>
            <Checkbox
              label="ליצור משימת קליטה"
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
                  defaultValue={values?.task_due_date ?? setup.nextWorkingDay}
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
          </>
        )}
      </fieldset>
      <OldCloseDateQuestion day={asking} onConfirm={confirm} onCancel={cancel} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="סוגרים…">סגירה בהצלחה</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
