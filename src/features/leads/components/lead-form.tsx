"use client";

import { useActionState, useState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { CheckedTextField } from "@/features/data-quality/components/checked-field";
import { DuplicateNotice } from "@/features/data-quality/components/duplicate-notice";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createLeadAction } from "../actions";
import { LeadCampaignFields } from "./lead-campaign-fields";
import type { LeadSourceOption, LeadStatusOption } from "../queries";

// reasons: the organization's active "not relevant" reasons (LEAD-03); empty: typed in freely
type Props = { orgId: string; statuses: LeadStatusOption[]; sources: LeadSourceOption[]; fields: FieldDefinition[]; reasons: string[] };

/** New lead form. On success the action redirects to the lead's page. */
export function LeadForm({ orgId, statuses, sources, fields, reasons }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(createLeadAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values ?? {};
  const errors = failure?.fieldErrors ?? {};

  // a new lead cannot start as "converted"
  const selectable = statuses.filter((status) => status.kind !== "converted");
  const defaultStatus = values.status_id ?? selectable.find((status) => status.isDefault)?.id ?? selectable[0]?.id ?? "";
  const manualSource = values.source_id ?? "";
  // a lead that starts "not relevant" needs a reason, as in the status form (RVW-9)
  const [statusId, setStatusId] = useState(defaultStatus);
  const [reason, setReason] = useState(values.disqualify_reason ?? "");
  const needsReason = statuses.find((status) => status.id === statusId)?.kind === "disqualified";

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.message} />
      {errors.allow_duplicate ? <DuplicateNotice href={errors.allow_duplicate} createLabel="ליצור ליד חדש בכל זאת" /> : null}
      <TextField
        label="שם מלא"
        name="full_name"
        autoComplete="off"
        maxLength={200}
        hint="חובה למלא לפחות אחד: שם, טלפון או אימייל."
        defaultValue={values.full_name}
        error={errors.full_name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <CheckedTextField
          check="phone"
          label="טלפון"
          name="phone"
          type="tel"
          dir="ltr"
          inputMode="tel"
          autoComplete="off"
          defaultValue={values.phone}
          error={errors.phone}
        />
        <CheckedTextField
          check="email"
          label="אימייל"
          name="email"
          type="email"
          dir="ltr"
          inputMode="email"
          autoComplete="off"
          defaultValue={values.email}
          error={errors.email}
        />
      </div>
      <TextField
        label="חברה"
        name="company_name"
        autoComplete="off"
        maxLength={200}
        defaultValue={values.company_name}
        error={errors.company_name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField key={`source-${manualSource}`} label="מקור" name="source_id" defaultValue={manualSource} error={errors.source_id}>
          <option value="">ללא מקור</option>
          {sources.filter((source) => source.isActive).map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="סטטוס"
          name="status_id"
          required
          value={statusId}
          onChange={(event) => setStatusId(event.target.value)}
          error={errors.status_id}
        >
          {selectable.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>
      </div>
      {needsReason ? (
        <DisqualifyReasonField
          reasons={reasons}
          label="למה הליד לא רלוונטי?"
          name="disqualify_reason"
          value={reason}
          onChange={setReason}
          error={errors.disqualify_reason}
        />
      ) : null}
      <LeadCampaignFields values={values} errors={errors} />
      <TextareaField
        label="הודעה או הערה ראשונה"
        name="message"
        rows={4}
        maxLength={5000}
        defaultValue={values.message}
        error={errors.message}
      />
      <CustomFieldInputs definitions={fields} submitted={failure?.values} errors={errors} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים ליד…">יצירת ליד</SubmitButton>
        <ButtonLink href={paths.leads(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}
