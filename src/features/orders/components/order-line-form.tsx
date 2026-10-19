"use client";

import { useActionState, useEffect, useRef } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addOrderLineAction } from "../actions";
import { ORDER_LINE_DESCRIPTION_MAX, ORDER_LINE_NAME_MAX } from "../schema";

/** ORD-01: a free line on a draft order: name, description, quantity and unit price. */
export function OrderLineForm({ orgId, orderId, pricesIncludeVat }: { orgId: string; orderId: string; pricesIncludeVat: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(addOrderLineAction.bind(null, orgId, orderId), null);
  const failed = state && !state.ok ? state : null;
  const v = (name: string) => failed?.values?.[name] ?? "";
  const form = useRef<HTMLFormElement>(null);
  // a saved line empties the form for the next one
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={formAction} className="space-y-3">
      <FormError message={failed?.message ?? null} />
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
      <TextField name="name" label="שם" required maxLength={ORDER_LINE_NAME_MAX} defaultValue={v("name")} error={failed?.fieldErrors?.name} />
      <TextField name="description" label="תיאור" maxLength={ORDER_LINE_DESCRIPTION_MAX} defaultValue={v("description")} error={failed?.fieldErrors?.description} />
      <div className="flex flex-wrap gap-3">
        <TextField name="quantity" label="כמות" inputMode="decimal" dir="ltr" defaultValue={v("quantity") || "1"} error={failed?.fieldErrors?.quantity} className="w-28" />
        <TextField
          name="unit_price"
          label={pricesIncludeVat ? 'מחיר ליחידה (כולל מע"מ)' : 'מחיר ליחידה (לפני מע"מ)'}
          inputMode="decimal"
          dir="ltr"
          required
          defaultValue={v("unit_price")}
          error={failed?.fieldErrors?.unit_price}
          className="w-44"
        />
      </div>
      <SubmitButton pendingText="מוסיפים…">הוספת שורה</SubmitButton>
    </form>
  );
}
