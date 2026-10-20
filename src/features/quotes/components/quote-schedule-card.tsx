"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";
import { formatDate, formatMoney } from "@/lib/format";

import { addOrderScheduleStepAction, deleteOrderScheduleStepAction, updateOrderScheduleStepAction } from "@/features/orders/schedule-actions";

import {
  FULL_BP,
  percentText,
  SCHEDULE_MAX,
  SCHEDULE_MILESTONE_MAX,
  SCHEDULE_NAME_MAX,
  scheduleRows,
  scheduleTotalBp,
  scheduleTotalNote,
  type ScheduleOwner,
  type ScheduleStep,
} from "../schedule";
import { addScheduleStepAction, deleteScheduleStepAction, updateScheduleStepAction } from "../schedule-actions";

type Props = {
  orgId: string;
  // the quote's id, or the order's (kind "order", ORD-04: the same mechanism)
  ownerId: string;
  kind?: ScheduleOwner;
  steps: ScheduleStep[];
  // the total to pay, for each step's share
  totalAgorot: number;
  // a hint only: a draft the user may edit (RLS decides)
  canEdit: boolean;
};

// each kind writes its own table through its own actions
const ACTIONS = {
  quote: { add: addScheduleStepAction, update: updateScheduleStepAction, remove: deleteScheduleStepAction },
  order: { add: addOrderScheduleStepAction, update: updateOrderScheduleStepAction, remove: deleteOrderScheduleStepAction },
} as const;

const EMPTY_TEXT: Record<ScheduleOwner, string> = {
  quote: "אין לוח תשלומים. אפשר לחלק את הסכום לתשלומים לפי תאריכים או אבני דרך, והלקוח יראה אותם בהצעה.",
  order: "אין לוח תשלומים. אפשר לחלק את הסכום לתשלומים לפי תאריכים או אבני דרך (מקדמה, אבני דרך, יתרה), והם יופיעו באישור ההזמנה.",
};

/** When a step is due: its date, its milestone, or both. */
export function scheduleWhen(step: { dueDate: string | null; milestone: string | null }): string {
  const date = step.dueDate ? formatDate(`${step.dueDate}T12:00:00Z`) : null;
  return [date, step.milestone].filter(Boolean).join(", ");
}

const percentInput = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, ""));

function StepForm({
  orgId,
  ownerId,
  kind,
  step,
  rest,
  onDone,
  onCancel,
}: {
  orgId: string;
  ownerId: string;
  kind: ScheduleOwner;
  step: ScheduleStep | null;
  rest: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const action = step ? ACTIONS[kind].update.bind(null, orgId, ownerId, step.id) : ACTIONS[kind].add.bind(null, orgId, ownerId);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="שם התשלום"
        name="name"
        required
        maxLength={SCHEDULE_NAME_MAX}
        defaultValue={values?.name ?? step?.name ?? ""}
        placeholder="למשל: מקדמה"
        error={errors.name}
      />
      <TextField
        label="אחוז מהסכום לתשלום"
        name="percent"
        required
        dir="ltr"
        inputMode="decimal"
        autoComplete="off"
        defaultValue={values?.percent ?? (step ? percentInput(step.percentBp) : rest > 0 ? percentInput(rest) : "")}
        hint="עד שתי ספרות אחרי הנקודה."
        error={errors.percent}
      />
      <DateField label="מועד" name="due_date" defaultValue={values?.due_date ?? step?.dueDate ?? ""} hint="תאריך, אבן דרך או שניהם." error={errors.due_date} />
      <TextField
        label="אבן דרך"
        name="milestone"
        maxLength={SCHEDULE_MILESTONE_MAX}
        defaultValue={values?.milestone ?? step?.milestone ?? ""}
        placeholder="למשל: בסיום ההתקנה"
        error={errors.milestone}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">{step ? "שמירה" : "הוספת התשלום"}</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/**
 * GAP-09: the quote's payment schedule (ORD-04: and an order's). Each step has a name, a percent of the total to pay and
 * when (a date, a milestone, or both), and shows its share of the total. A draft may be incomplete; sending a quote, or
 * confirming an order, needs exactly 100%.
 */
export function PaymentScheduleCard({ orgId, ownerId, kind = "quote", steps, totalAgorot, canEdit }: Props) {
  const [editing, setEditing] = useState<ScheduleStep | "new" | null>(null);
  const rows = scheduleRows(totalAgorot, steps);
  const total = scheduleTotalBp(steps);
  const note = scheduleTotalNote(steps, kind);
  const titleId = `${kind}-schedule-title`;
  const full = steps.length >= SCHEDULE_MAX || total >= FULL_BP;
  const close = () => setEditing(null);

  if (!canEdit && steps.length === 0) return null;

  return (
    <Card aria-labelledby={titleId} className={kind === "quote" ? "mb-5" : undefined}>
      <CardHeader
        id={titleId}
        title="לוח תשלומים"
        action={
          canEdit && !full ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
              <PlusIcon className="size-4" />
              הוספת תשלום
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-3">
        {steps.length === 0 ? (
          <p className="text-md text-ink-soft">{EMPTY_TEXT[kind]}</p>
        ) : (
          <ol aria-label="התשלומים" className="divide-y divide-line">
            {steps.map((step, index) => (
              <li key={step.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">
                    <bdi>{step.name}</bdi>
                  </p>
                  <p className="text-sm text-ink-soft">
                    <span className="tabular-nums">{percentText(step.percentBp)}</span>
                    {scheduleWhen(step) ? `, ${scheduleWhen(step)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="me-1 font-semibold tabular-nums">{formatMoney(rows[index].amountAgorot)}</span>
                  {canEdit ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(step)} aria-label={`עריכה: ${step.name}`}>
                        עריכה
                      </Button>
                      <ConfirmButton
                        title={`למחוק את התשלום "${step.name}"?`}
                        confirmLabel="מחיקה"
                        action={() => ACTIONS[kind].remove(orgId, ownerId, step.id)}
                      >
                        מחיקה
                      </ConfirmButton>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        {steps.length > 0 ? (
          <p className="flex justify-between gap-3 border-t border-line pt-3 text-md">
            <span className="text-ink-soft">סך הכול</span>
            <span className="font-semibold tabular-nums">{percentText(total)}</span>
          </p>
        ) : null}
        {note ? (
          <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
            {note}
          </p>
        ) : null}
      </CardBody>
      {canEdit ? (
        <Dialog open={editing !== null} onClose={close} title={editing === "new" ? "תשלום חדש" : "עריכת תשלום"} variant="sheet">
          {editing !== null ? (
            <StepForm
              key={editing === "new" ? "new" : editing.id}
              orgId={orgId}
              ownerId={ownerId}
              kind={kind}
              step={editing === "new" ? null : editing}
              rest={editing === "new" ? FULL_BP - total : 0}
              onDone={close}
              onCancel={close}
            />
          ) : null}
        </Dialog>
      ) : null}
    </Card>
  );
}
