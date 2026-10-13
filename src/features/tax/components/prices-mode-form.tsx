"use client";

import { useActionState, useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { savePricesModeAction } from "../actions";
import { PRICES_MODE_OPTIONS, PRICES_NO_VAT_NOTE, pricesModeOf } from "../prices";

type Props = { orgId: string; pricesIncludeVat: boolean; charges: boolean | null };

/** Prices before VAT or including VAT (TAX-04). Owners and admins; the page shows one line to others. */
export function PricesModeForm({ orgId, pricesIncludeVat, charges }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(savePricesModeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const [mode, setMode] = useState<string>(failure?.values?.prices_mode ?? pricesModeOf(pricesIncludeVat));

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="prices-mode-title">
        <CardHeader id="prices-mode-title" title="מחירים במסמכים" />
        <CardBody className="space-y-5">
          <fieldset aria-describedby="prices-mode-note">
            <legend className="font-medium">איך מקלידים ומציגים מחירים</legend>
            <p id="prices-mode-note" className="mb-3 text-sm text-ink-soft">
              {"חל על מוצרים ועל מסמכים חדשים. בכל מסמך אפשר לבחור אחרת, ומסמך קיים לא משתנה."}
            </p>
            <div className="space-y-2">
              {PRICES_MODE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft"
                >
                  <input
                    type="radio"
                    name="prices_mode"
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() => setMode(option.value)}
                    className="mt-1 size-4 shrink-0 accent-accent"
                  />
                  <span>
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-sm text-ink-soft">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {charges === false ? <p className="mt-2 text-sm text-ink-soft">{PRICES_NO_VAT_NOTE}</p> : null}
            {errors.prices_mode ? <p className="mt-2 text-sm text-danger">{errors.prices_mode}</p> : null}
          </fieldset>

          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}
