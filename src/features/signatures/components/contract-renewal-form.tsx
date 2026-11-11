"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { CONTRACT_RENEWAL_CHOICES, contractRenewalLabel } from "../validity";
import { saveContractRenewalAction } from "../validity-actions";

type Props = { orgId: string; days: number };

/** SGN-04: how many days before a signed contract's renewal day (else its last day) the alert task is made. Owners and admins. */
export function ContractRenewalForm({ orgId, days }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveContractRenewalAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const picked = failure?.values?.contract_renewal_days ?? String(days);
  const choices = CONTRACT_RENEWAL_CHOICES.includes(days) ? CONTRACT_RENEWAL_CHOICES : [...CONTRACT_RENEWAL_CHOICES, days].sort((a, b) => a - b);

  return (
    <form action={formAction} noValidate className="space-y-3">
      <SelectField
        key={picked}
        label="התראה לפני חידוש של מסמך חתום"
        name="contract_renewal_days"
        defaultValue={picked}
        hint="משימה למי ששלח את המסמך, לפני מועד החידוש (או סוף התוקף כשאין מועד חידוש). משימה אחת לכל מסמך; היא נסגרת מעצמה כשהתאריכים נדחים או נמחקים."
        error={failure?.fieldErrors?.contract_renewal_days}
      >
        {choices.map((value) => (
          <option key={value} value={value}>
            {contractRenewalLabel(value)}
          </option>
        ))}
      </SelectField>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}
