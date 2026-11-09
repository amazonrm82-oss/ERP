"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveMeetingOrderDraftModeAction } from "../actions";
import { MEETING_ORDER_DRAFT_OPTIONS, type MeetingOrderDraftMode } from "../rules";

type Props = { orgId: string; mode: MeetingOrderDraftMode };

/** CAL-13: a held meeting's draft order, by the button or by itself. Owners and admins; the page shows one line to others. */
export function MeetingOrderDraftModeForm({ orgId, mode }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveMeetingOrderDraftModeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const [picked, setPicked] = useState<string>(failure?.values?.meeting_order_draft ?? mode);

  return (
    <form action={formAction} noValidate className="space-y-4">
      <fieldset aria-describedby="meeting-order-draft-note">
        <legend className="font-medium">טיוטת הזמנה מפגישה שהתקיימה</legend>
        <p id="meeting-order-draft-note" className="mb-3 text-sm text-ink-soft">
          רק לסוג פגישה עם מוצר מקושר, ורק כשלפגישה יש איש קשר. פגישה שנוצלה מכרטיסייה לא יוצרת הזמנה.
        </p>
        <div className="space-y-2">
          {MEETING_ORDER_DRAFT_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft"
            >
              <input
                type="radio"
                name="meeting_order_draft"
                value={option.value}
                checked={picked === option.value}
                onChange={() => setPicked(option.value)}
                className="mt-1 size-4 shrink-0 accent-accent"
              />
              <span>
                <span className="block font-medium">{option.label}</span>
                <span className="block text-sm text-ink-soft">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        {errors.meeting_order_draft ? <p className="mt-2 text-sm text-danger">{errors.meeting_order_draft}</p> : null}
      </fieldset>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}
