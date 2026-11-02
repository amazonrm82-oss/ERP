"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addCampaignCostAction, deleteCampaignCostAction, updateCampaignCostAction } from "../actions";

export type SourceOption = { id: string; name: string };
type Values = { source_id?: string; campaign?: string; month?: string; amount?: string; note?: string; amount_includes_vat?: string };

function CostFields({
  sources,
  campaigns,
  values,
  errors,
  showVat,
}: {
  sources: SourceOption[];
  campaigns: string[];
  values: Values;
  errors?: Record<string, string>;
  // owner (63) ב: only a business that charges VAT is asked whether the amount includes it
  showVat: boolean;
}) {
  const listId = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField label="מקור" name="source_id" defaultValue={values.source_id ?? ""} error={errors?.source_id}>
        <option value="">בלי מקור</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="קמפיין"
        name="campaign"
        maxLength={200}
        autoComplete="off"
        list={campaigns.length ? listId : undefined}
        defaultValue={values.campaign ?? ""}
        error={errors?.campaign}
        hint="בדיוק כמו שהקמפיין נרשם אצלכם (ההצעות מהרשומות האחרונות). אפשר להשאיר ריק ולשייך את העלות למקור בלבד."
      />
      {campaigns.length ? (
        <datalist id={listId}>
          {campaigns.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
      <TextField label="חודש" name="month" type="month" required min="2000-01" max="2100-12" defaultValue={values.month ?? ""} error={errors?.month} />
      <TextField label="סכום (₪)" name="amount" required inputMode="decimal" dir="ltr" autoComplete="off" defaultValue={values.amount ?? ""} error={errors?.amount} />
      <TextField label="הערה" name="note" maxLength={500} autoComplete="off" className="sm:col-span-2" defaultValue={values.note ?? ""} error={errors?.note} />
      {showVat ? (
        <Checkbox
          label='כולל מע"מ'
          name="amount_includes_vat"
          defaultChecked={values.amount_includes_vat === "on"}
          hint='הדוח מחשב את הסכום לפני מע"מ לפי שיעור המע"מ בחודש של העלות.'
          className="sm:col-span-2"
        />
      ) : null}
    </div>
  );
}

/** SEG-03: a new cost, on the campaign costs page. */
export function NewCampaignCostForm({
  orgId,
  sources,
  campaigns,
  month,
  showVat,
}: {
  orgId: string;
  sources: SourceOption[];
  campaigns: string[];
  month: string;
  showVat: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addCampaignCostAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    // a successful save resets the form (React), so the next cost starts empty
    <form action={formAction} className="space-y-3" noValidate>
      <CostFields sources={sources} campaigns={campaigns} values={failure?.values ?? { month }} errors={failure?.fieldErrors} showVat={showVat} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton pending={pending}>הוספת עלות</SubmitButton>
    </form>
  );
}

/** Changing or removing one cost, from its row. */
export function CampaignCostActions({
  orgId,
  cost,
  sources,
  campaigns,
  showVat,
}: {
  orgId: string;
  cost: { id: string; sourceId: string | null; campaign: string | null; month: string; amountText: string; includesVat: boolean; note: string | null };
  sources: SourceOption[];
  campaigns: string[];
  showVat: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateCampaignCostAction(orgId, cost.id, prev, formData);
    if (result?.ok) setOpen(false);
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values: Values = failure?.values ?? {
    source_id: cost.sourceId ?? "",
    campaign: cost.campaign ?? "",
    month: cost.month.slice(0, 7),
    amount: cost.amountText,
    note: cost.note ?? "",
    amount_includes_vat: cost.includesVat ? "on" : "",
  };
  return (
    <span className="flex flex-wrap gap-1">
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        עריכה
      </Button>
      <ConfirmButton title="למחוק את העלות?" description="הדוח יחושב בלעדיה." confirmLabel="מחיקה" action={deleteCampaignCostAction.bind(null, orgId, cost.id)}>
        מחיקה
      </ConfirmButton>
      <Dialog open={open} onClose={() => setOpen(false)} title="עריכת עלות">
        <form action={formAction} className="space-y-3" noValidate>
          <CostFields sources={sources} campaigns={campaigns} values={values} errors={failure?.fieldErrors} showVat={showVat || cost.includesVat} />
          <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
          <div className="flex gap-2">
            <SubmitButton pending={pending}>שמירה</SubmitButton>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </form>
      </Dialog>
    </span>
  );
}
