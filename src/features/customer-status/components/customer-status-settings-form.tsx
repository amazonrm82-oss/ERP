"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveCustomerStatusSettingsAction } from "../actions";
import { DORMANT_MAX, DORMANT_MIN, FORMER_MAX, FORMER_MIN } from "../status";

type Props = { orgId: string; dormantMonths: number; formerMonths: number };

/** CON-11: after how many months without a purchase a customer counts as dormant, then former. Owners and admins. */
export function CustomerStatusSettingsForm({ orgId, dormantMonths, formerMonths }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveCustomerStatusSettingsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="customer-status-title">
        <CardHeader id="customer-status-title" title="סטטוס לקוח" />
        <CardBody className="space-y-5">
          <TextField
            label="לקוח רדום אחרי (חודשים בלי קנייה)"
            name="dormant_months"
            type="number"
            inputMode="numeric"
            min={DORMANT_MIN}
            max={DORMANT_MAX}
            step={1}
            dir="ltr"
            className="max-w-40"
            hint={`בין ${DORMANT_MIN} ל-${DORMANT_MAX} חודשים.`}
            defaultValue={failure?.values?.dormant_months ?? String(dormantMonths)}
            error={errors.dormant_months}
          />
          <TextField
            label="לקוח לשעבר אחרי (חודשים בלי קנייה)"
            name="former_months"
            type="number"
            inputMode="numeric"
            min={FORMER_MIN}
            max={FORMER_MAX}
            step={1}
            dir="ltr"
            className="max-w-40"
            hint={`בין ${FORMER_MIN} ל-${FORMER_MAX} חודשים, יותר מהמספר של לקוח רדום.`}
            defaultValue={failure?.values?.former_months ?? String(formerMonths)}
            error={errors.former_months}
          />
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}
