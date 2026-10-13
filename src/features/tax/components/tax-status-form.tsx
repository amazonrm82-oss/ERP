"use client";

import { useActionState, useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveTaxSettingsAction } from "../actions";
import type { TaxSettings } from "../settings";
import { LEGAL_FORM_OPTIONS, VAT_STATUS_OPTIONS, VAT_STATUS_OTHER_MAX } from "../status";

type Props = { orgId: string; settings: TaxSettings };

/** The legal form and the VAT status of the business (TAX-01). Owners and admins; the page shows a read-only view to others. */
export function TaxStatusForm({ orgId, settings }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveTaxSettingsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const legalForm = values?.legal_form ?? settings.legalForm ?? "";
  const [status, setStatus] = useState<string>(values?.vat_status ?? settings.vatStatus ?? "");
  const otherCharges = values?.other_charges_vat ?? (settings.otherChargesVat === null ? "" : settings.otherChargesVat ? "yes" : "no");

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="tax-status-title">
        <CardHeader id="tax-status-title" title='מעמד במע"מ' />
        <CardBody className="space-y-5">
          <fieldset aria-describedby="vat-status-note">
            <legend className="font-medium">המעמד של העסק</legend>
            <p id="vat-status-note" className="mb-3 text-sm text-ink-soft">
              {'קובע אם יש מע"מ בהצעות המחיר ובמסמכים. מי שלא גובה מע"מ לא יראה מע"מ באף מסמך.'}
            </p>
            <div className="space-y-2">
              {VAT_STATUS_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft"
                >
                  <input
                    type="radio"
                    name="vat_status"
                    value={option.value}
                    checked={status === option.value}
                    onChange={() => setStatus(option.value)}
                    className="mt-1 size-4 shrink-0 accent-accent"
                  />
                  <span>
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-sm text-ink-soft">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {errors.vat_status ? <p className="mt-2 text-sm text-danger">{errors.vat_status}</p> : null}
          </fieldset>

          {status === "other" ? (
            <div className="space-y-4 rounded-md border border-line p-3">
              <TextField
                label="שם המעמד"
                name="vat_status_other"
                required
                maxLength={VAT_STATUS_OTHER_MAX}
                hint="כפי שנקבע עם רואה החשבון."
                defaultValue={values?.vat_status_other ?? settings.vatStatusOther ?? ""}
                error={errors.vat_status_other}
              />
              <SelectField
                key={`charges-${otherCharges}`}
                label='האם המעמד גובה מע"מ?'
                name="other_charges_vat"
                required
                defaultValue={otherCharges}
                error={errors.other_charges_vat}
              >
                <option value="">יש לבחור</option>
                <option value="yes">{'כן, גובה מע"מ'}</option>
                <option value="no">{'לא, בלי מע"מ'}</option>
              </SelectField>
            </div>
          ) : null}

          {/* key: a select only takes defaultValue on mount */}
          <SelectField
            key={`legal-${legalForm}`}
            label="צורת ההתאגדות"
            name="legal_form"
            hint='נשמרת בנפרד, ולא קובעת אם יש מע"מ.'
            defaultValue={legalForm}
            error={errors.legal_form}
          >
            <option value="">לא נבחר</option>
            {LEGAL_FORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>

          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}
