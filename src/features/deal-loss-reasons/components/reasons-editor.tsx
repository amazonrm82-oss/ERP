"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addLossReasonAction, deleteLossReasonAction, moveLossReasonAction, renameLossReasonAction, setLossReasonActiveAction } from "../actions";
import type { LossReason } from "../queries";
import { LOSS_REASON_MAX } from "../schema";

/** The organization's deal loss reasons (DEAL-03): rename, hide, reorder and delete. */
export function LossReasonList({ orgId, reasons, editable }: { orgId: string; reasons: LossReason[]; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {reasons.map((reason, index) => (
        <ReasonRow
          key={`${reason.id}-${reason.name}-${reason.isActive}`}
          orgId={orgId}
          reason={reason}
          editable={editable}
          isFirst={index === 0}
          isLast={index === reasons.length - 1}
        />
      ))}
    </ol>
  );
}

type RowProps = { orgId: string; reason: LossReason; editable: boolean; isFirst: boolean; isLast: boolean };

function ReasonRow({ orgId, reason, editable, isFirst, isLast }: RowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(renameLossReasonAction.bind(null, orgId, reason.id), null);
  const failure = state && !state.ok ? state : null;

  if (!editable) {
    return (
      <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span className="min-w-0 break-words font-medium">{reason.name}</span>
        {reason.isActive ? null : <Badge>מוסתרת</Badge>}
      </li>
    );
  }

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <form action={formAction} className="flex items-start gap-2" noValidate>
        <TextField
          label={`שם הסיבה ${reason.name}`}
          hideLabel
          name="name"
          required
          maxLength={LOSS_REASON_MAX}
          autoComplete="off"
          controlSize="sm"
          className="min-w-0 flex-1"
          defaultValue={failure?.values?.name ?? reason.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {reason.name}</span>
        </SubmitButton>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        {reason.isActive ? null : <Badge>מוסתרת</Badge>}
        <ActionButton action={moveLossReasonAction.bind(null, orgId, reason.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={reason.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveLossReasonAction.bind(null, orgId, reason.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={reason.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton action={setLossReasonActiveAction.bind(null, orgId, reason.id, !reason.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={reason.name}>
          {reason.isActive ? "הסתרה" : "הצגה"}
        </ActionButton>
        <ActionButton
          action={deleteLossReasonAction.bind(null, orgId, reason.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          srLabel={reason.name}
          confirm={`למחוק את הסיבה "${reason.name}"? עסקאות שכבר סומנו בה ישמרו אותה.`}
        >
          מחיקה
        </ActionButton>
      </div>
    </li>
  );
}

export function AddLossReasonForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addLossReasonAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex items-start gap-2" noValidate>
      <TextField
        label="סיבה חדשה"
        hideLabel
        placeholder="סיבה חדשה, למשל: אין תקציב"
        name="name"
        required
        maxLength={LOSS_REASON_MAX}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-1"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת סיבה
      </SubmitButton>
    </form>
  );
}
