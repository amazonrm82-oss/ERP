"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormError } from "@/components/ui/feedback";
import { Input } from "@/components/ui/field";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";

import { setDealLineCostAction } from "../actions";

type Props = {
  orgId: string;
  dealId: string;
  lineId: string;
  // the line's own cost per unit (null = none kept), and the product's cost in the catalog today (null = none)
  cost: number | null;
  catalog: number | null;
  // a hint only (the database decides): the deal is open and the user may edit it
  canEdit: boolean;
};

const shekels = (agorot: number) => (agorot / 100).toFixed(2);

/**
 * PRD-06 follow-up (owner, 15 October 2026): the cost kept on a deal line, for those who see costs. On an open deal it can
 * be changed, and when the catalog cost has changed since the line was made, it can be brought up to date. A closed deal
 * shows it locked.
 */
export function LineCost({ orgId, dealId, lineId, cost, catalog, canEdit }: Props) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const action = setDealLineCostAction.bind(null, orgId, dealId, lineId);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) setEditing(false);
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const changed = catalog !== null && cost !== null && catalog !== cost;

  return (
    <div className="mt-1 space-y-1 text-sm text-ink-soft print:hidden">
      <p>
        {cost === null ? "אין עלות לשורה" : <>עלות ליחידה: <span className="tabular-nums">{formatMoney(cost)}</span></>}
        {canEdit && !editing ? (
          <Button variant="ghost" size="sm" className="ms-1" onClick={() => setEditing(true)}>
            {cost === null ? "הוספת עלות" : "שינוי"}
          </Button>
        ) : null}
      </p>
      {changed ? (
        <form action={formAction} className="flex flex-wrap items-center gap-2">
          <span className="text-warning">
            העלות בקטלוג השתנתה ל-<span className="tabular-nums">{formatMoney(catalog)}</span>.
          </span>
          {canEdit ? (
            <>
              <input type="hidden" name="cost" value={shekels(catalog)} />
              <SubmitButton size="sm" variant="secondary">
                עדכון לעלות שבקטלוג
              </SubmitButton>
            </>
          ) : null}
        </form>
      ) : null}
      {editing ? (
        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <label htmlFor={inputId} className="sr-only">
            עלות ליחידה בשקלים
          </label>
          <Input
            id={inputId}
            name="cost"
            inputMode="decimal"
            dir="ltr"
            controlSize="sm"
            className="w-28"
            defaultValue={failure?.values?.cost ?? (cost === null ? "" : shekels(cost))}
            aria-invalid={failure ? true : undefined}
          />
          <SubmitButton size="sm">שמירה</SubmitButton>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            ביטול
          </Button>
          <p className="basis-full">שדה ריק מסיר את העלות מהשורה.</p>
        </form>
      ) : null}
      <FormError message={failure ? (failure.fieldErrors?.cost ?? failure.message) : null} />
    </div>
  );
}
