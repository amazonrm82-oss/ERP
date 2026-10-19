"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { QUOTE_ACCEPT_DEAL_OPTIONS, type QuoteAcceptDeal } from "../accept-deal";
import { saveQuoteAcceptDealAction } from "../accept-deal-actions";

type Props = { orgId: string; mode: QuoteAcceptDeal };

/** QUO-13: what happens to the deal when a customer accepts a quote. Owners and admins; the page shows one line to others. */
export function QuoteAcceptDealForm({ orgId, mode }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveQuoteAcceptDealAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const [picked, setPicked] = useState<string>(failure?.values?.quote_accept_deal ?? mode);

  return (
    <form action={formAction} noValidate className="space-y-4">
      <fieldset aria-describedby="quote-accept-deal-note">
        <legend className="font-medium">כשלקוח מאשר הצעה, מה קורה בעסקה שלה?</legend>
        <p id="quote-accept-deal-note" className="mb-3 text-sm text-ink-soft">
          רק עסקה פתוחה מתעדכנת. עסקה סגורה, עסקה בסל המחזור ותוספת להצעה לא משתנות.
        </p>
        <div className="space-y-2">
          {QUOTE_ACCEPT_DEAL_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft"
            >
              <input
                type="radio"
                name="quote_accept_deal"
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
        {errors.quote_accept_deal ? <p className="mt-2 text-sm text-danger">{errors.quote_accept_deal}</p> : null}
      </fieldset>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}
