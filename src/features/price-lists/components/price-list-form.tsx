"use client";

import { useActionState } from "react";

import { DateField } from "@/components/ui/date-picker";
import { Checkbox, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { createPriceListAction, updatePriceListAction } from "../actions";
import type { PriceList } from "../queries";
import { PRICE_LIST_NAME_MAX } from "../schema";

type Props = {
  orgId: string;
  // null: a new price list
  list: PriceList | null;
  timeZone: string;
};

/** Create or edit a price list (PL-01). Owners and admins only; the page decides. */
export function PriceListForm({ orgId, list, timeZone }: Props) {
  const action = list ? updatePriceListAction.bind(null, orgId, list.id) : createPriceListAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const typed = failure?.values;
  const value = (name: string, stored: string | null | undefined) => typed?.[name] ?? stored ?? "";
  const isActive = typed ? typed.is_active === "on" : (list?.isActive ?? true);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.message} />
      {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
      <TextField
        label="שם המחירון"
        name="name"
        required
        maxLength={PRICE_LIST_NAME_MAX}
        autoComplete="off"
        placeholder="למשל: סיטונאים"
        defaultValue={value("name", list?.name)}
        error={errors.name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField
          label="בתוקף מתאריך"
          name="valid_from"
          hint="ריק: מעכשיו."
          timeZone={timeZone}
          defaultValue={value("valid_from", list?.validFrom)}
          error={errors.valid_from}
        />
        <DateField
          label="עד תאריך"
          name="valid_to"
          hint="ריק: בלי תאריך סיום. היום האחרון כלול."
          timeZone={timeZone}
          defaultValue={value("valid_to", list?.validTo)}
          error={errors.valid_to}
        />
      </div>
      <Checkbox name="is_active" label="פעיל" hint="מחירון לא פעיל לא משמש לחישוב מחירים." defaultChecked={isActive} />
      <div className="pt-1">
        <SubmitButton pendingText={list ? "שומרים…" : "יוצרים מחירון…"}>{list ? "שמירה" : "יצירת מחירון"}</SubmitButton>
      </div>
    </form>
  );
}
