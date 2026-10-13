"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveBankDetailsAction } from "../actions";
import type { BankDetails } from "../settings";

type Props = { orgId: string; details: BankDetails };

/** Bank details for a transfer (TAX-02 follow-up). Owners and admins only: the page never renders it for anyone else. */
export function BankDetailsForm({ orgId, details }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveBankDetailsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const value = (name: string, saved: string | null) => values?.[name] ?? saved ?? "";

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="doc-bank-title">
        <CardHeader id="doc-bank-title" title="פרטים להעברה בנקאית" />
        <CardBody className="space-y-4">
          <p className="text-sm text-ink-soft">מוצגים ללקוח בהצעת מחיר ובדרישת תשלום, כדי שיוכל להעביר כסף. רק בעלים ומנהלי מערכת רואים ומשנים אותם, וכל שינוי נשלח להם כהתראה.</p>
          <TextField
            label="בנק"
            name="bank_name"
            maxLength={80}
            hint="למשל: בנק לאומי"
            defaultValue={value("bank_name", details.bankName)}
            error={errors.bank_name}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="סניף"
              name="bank_branch"
              dir="ltr"
              inputMode="numeric"
              maxLength={10}
              defaultValue={value("bank_branch", details.bankBranch)}
              error={errors.bank_branch}
            />
            <TextField
              label="מספר חשבון"
              name="bank_account"
              dir="ltr"
              inputMode="numeric"
              maxLength={30}
              defaultValue={value("bank_account", details.bankAccount)}
              error={errors.bank_account}
            />
          </div>
          <TextField
            label="שם בעל החשבון"
            name="bank_account_name"
            maxLength={120}
            defaultValue={value("bank_account_name", details.bankAccountName)}
            error={errors.bank_account_name}
          />
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}
