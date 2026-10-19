"use client";

import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { AskedFields } from "@/features/custom-fields/components/asked-fields";
import { isMoveRefusal } from "@/features/custom-fields/required-move";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { missingForMoveAction } from "@/features/record-move/actions";
import type { FormState } from "@/lib/action-result";

import { closeDealWonAction, closeOpenDealWonAction, closeQuoteDealWonAction, dealOnboardingTaskAction, dealOrderStateAction } from "../actions";
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
// amountHint (QUO-13): what the prefilled amount is, e.g. an accepted quote's total
export type WonTarget = { dealId: string; dealName: string; stageId: string; stageName: string; amountAgorot: number; ownerId: string | null; amountHint?: string };

export type { CloseWindowSetup };

// expectOpen: only a deal that is still open is closed (GOL-04, the forecast's overdue list)
// quoteId (QUO-13): the deal of this accepted quote; its lines become the quote's in the same save (an open deal only).
// onDone gets the save's message, if any (a quote whose lines were kept).
type Props = {
  orgId: string;
  target: WonTarget | null;
  setup: CloseWindowSetup;
  onClose: () => void;
  onDone?: (target: WonTarget, message?: string) => void;
  expectOpen?: boolean;
  quoteId?: string;
};

/**
 * DEAL-04, the close window on the won side: confirm the amount and the close
 * date, fill the fields the won stage makes required (FLD-09), and choose what comes next (wave 1: an
 * onboarding task). Nothing moves
 * until "סגירה בהצלחה" is pressed; closing the window leaves the deal where it was.
 */
export function DealWonDialog({ orgId, target, setup, onClose, onDone, expectOpen = false, quoteId }: Props) {
  return (
    <Dialog open={target !== null} onClose={onClose} title="העסקה נסגרה בהצלחה?" description={target ? `${target.dealName} · שלב ${target.stageName}` : undefined} variant="sheet">
      {target ? (
        <WonForm
          key={`${target.dealId}-${target.stageId}`}
          orgId={orgId}
          target={target}
          setup={setup}
          expectOpen={expectOpen}
          quoteId={quoteId}
          onCancel={onClose}
          onDone={(message) => {
            onDone?.(target, message);
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

function WonForm({
  orgId,
  target,
  setup,
  expectOpen,
  quoteId,
  onCancel,
  onDone,
}: {
  orgId: string;
  target: WonTarget;
  setup: CloseWindowSetup;
  expectOpen: boolean;
  quoteId?: string;
  onCancel: () => void;
  onDone: (message?: string) => void;
}) {
  const choiceKey = onboardingChoiceKey(orgId, setup.userId);
  // an open onboarding task already linked to the deal: none is offered (checked again on save)
  const [existing, setExisting] = useState<"checking" | "open" | "none">("checking");
  // FLD-09: the fields the won stage makes required and are empty, asked here and saved with the close
  // (when this read fails, the first save names them and they show then)
  const [required, setRequired] = useState<FieldDefinition[]>([]);
  // DEAL-05: the won stage requires the amount (the save checks it either way)
  const [amountRequired, setAmountRequired] = useState(false);
  // DEAL-04 wave 2: an order is offered while the orders module is on and the deal has none yet (the database checks again)
  const [orderState, setOrderState] = useState<"checking" | "has" | "none">(setup.orders ? "checking" : "has");
  useEffect(() => {
    let cancelled = false;
    if (setup.orders) {
      dealOrderStateAction(orgId, target.dealId)
        .then((result) => {
          if (!cancelled) setOrderState(result.ok && result.data?.has ? "has" : "none");
        })
        .catch(() => {
          if (!cancelled) setOrderState("none");
        });
    }
    dealOnboardingTaskAction(orgId, target.dealId)
      .then((result) => {
        if (!cancelled) setExisting(result.ok && result.data?.open ? "open" : "none");
      })
      .catch(() => {
        if (!cancelled) setExisting("none");
      });
    missingForMoveAction(orgId, "deal", target.dealId, target.stageId)
      .then((result) => {
        if (!cancelled && result.ok && result.data) {
          setRequired(result.data.fields);
          setAmountRequired(result.data.amountRequired);
        }
      })
      .catch(() => {
        // the save checks again
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, target.dealId, target.stageId, setup.orders]);

  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = quoteId
      ? await closeQuoteDealWonAction(orgId, quoteId, target.dealId, target.stageId, prev, formData)
      : await (expectOpen ? closeOpenDealWonAction : closeDealWonAction)(orgId, target.dealId, target.stageId, prev, formData);
    if (result?.ok) {
      if (existing !== "open") rememberChoice(choiceKey, formData.get("onboarding") === "on");
      onDone(result.message);
    }
    return result;
  }, null);
  // a close date more than three months back is confirmed first
  const { onSubmit, asking, confirm, cancel } = useOldCloseDate(setup.today);
  const failure = state && !state.ok ? state : null;
  const asked = isMoveRefusal(state) ? state.missing : required;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [onboarding, setOnboarding] = useState(() => (values ? values.onboarding === "on" : readChoice(choiceKey)));
  const ownerDefault = values?.task_owner_id ?? (target.ownerId && setup.owners.some((o) => o.value === target.ownerId) ? target.ownerId : "");

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      {quoteId ? <p className="text-sm text-ink-soft">השורות של העסקה יתעדכנו מההצעה כשתסגרו בהצלחה. ביטול לא משנה דבר.</p> : null}
      <TextField
        label="סכום סופי (₪)"
        name="amount"
        required={amountRequired}
        dir="ltr"
        inputMode="decimal"
        autoComplete="off"
        autoFocus
        defaultValue={values?.amount ?? amountInputValue(target.amountAgorot)}
        hint={target.amountHint}
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
      <AskedFields object="deal" fields={asked} submitted={values} errors={errors} />
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
        {setup.orders && orderState === "none" ? (
          <Checkbox
            label="ליצור הזמנה"
            hint={
              quoteId
                ? "הזמנה ממוספרת עם השורות והמחירים שהלקוח אישר בהצעה."
                : "הזמנה ממוספרת מההצעה שהלקוח אישר, ואם אין כזו, משורות העסקה."
            }
            name="create_order"
            defaultChecked={values?.create_order === "on"}
          />
        ) : setup.orders && orderState === "has" ? (
          <p className="text-sm text-ink-soft">לעסקה כבר יש הזמנה.</p>
        ) : null}
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
