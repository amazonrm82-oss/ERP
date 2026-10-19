"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveTermsAction } from "../actions";
import { CONTACT_TERMS, DEAL_TERMS, LEAD_TERMS, type OrgTermKeys, type TermForms } from "../terms";

type Props = { orgId: string; keys: OrgTermKeys };

const options = (list: Record<string, TermForms>) =>
  Object.entries(list).map(([key, term]) => (
    <option key={key} value={key}>
      {`${term.singular} (${term.plural})`}
    </option>
  ));

/** FLD-10: three choices from ready lists; the first of each list is today's word. */
export function TermsForm({ orgId, keys }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveTermsAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-5">
      <FormError message={failed?.message ?? null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField label="אנשי הקשר נקראים" name="contact_term" defaultValue={keys.contact ?? "contact"}>
          {options(CONTACT_TERMS)}
        </SelectField>
        <SelectField label="הלידים נקראים" name="lead_term" defaultValue={keys.lead ?? "lead"}>
          {options(LEAD_TERMS)}
        </SelectField>
        <SelectField label="העסקאות נקראות" name="deal_term" defaultValue={keys.deal ?? "deal"}>
          {options(DEAL_TERMS)}
        </SelectField>
      </div>
      <SubmitButton>שמירת המונחים</SubmitButton>
    </form>
  );
}
