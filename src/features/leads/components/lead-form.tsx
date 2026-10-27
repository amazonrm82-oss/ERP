"use client";

import { useActionState, useEffect, useRef, useState } from "react";

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

import { createLeadAction, createLeadStayAction } from "../actions";
import { RequestedProductPicker } from "@/features/requested-product/components/requested-product-picker";

import { LeadCampaignFields } from "./lead-campaign-fields";
import { LeadChannelField } from "./lead-channel-field";
import { LeadLocaleField } from "./lead-locale-field";
import type { LeadSourceOption, LeadStatusOption } from "../queries";

// reasons: the organization's active "not relevant" reasons (LEAD-03); empty: typed in freely
// products: LEAD-04, the requested product picker shows when the plan has the product catalog
// prefill: WAB-06, starting values from something shared to the app (full_name, phone, email, message); still editable
type Props = {
  orgId: string;
  statuses: LeadStatusOption[];
  sources: LeadSourceOption[];
  fields: FieldDefinition[];
  reasons: string[];
  products?: boolean;
  prefill?: Record<string, string>;
  // WAB-06: called with the new lead's id instead of going to its page (the share screen saves a note on it first)
  onCreated?: (id: string) => void;
};

/** New lead form. On success the action redirects to the lead's page, or hands the new id to `onCreated`. */
export function LeadForm({ orgId, statuses, sources, fields, reasons, products = false, prefill, onCreated }: Props) {
  // which action is fixed when the form mounts (the share screen always passes onCreated)
  const [stay] = useState(() => onCreated !== undefined);
  const [state, formAction] = useActionState<FormState<{ id: string }>, FormData>(
    stay ? createLeadStayAction.bind(null, orgId) : (createLeadAction.bind(null, orgId) as (prev: FormState<{ id: string }>, form: FormData) => Promise<FormState<{ id: string }>>),
    null,
  );
  const created = useRef(onCreated);
  useEffect(() => {
    created.current = onCreated;
  });
  const createdId = state?.ok ? state.data?.id : undefined;
  useEffect(() => {
    if (createdId) created.current?.(createdId);
  }, [createdId]);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values ?? prefill ?? {};
  // WAB-06: prefilled values are not saved yet. FormGuard takes its starting point when it mounts; this marker is then
  // emptied (its value attribute changes, which FormGuard watches), so leaving a prefilled form asks first.
  const prefillMarker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (prefillMarker.current) prefillMarker.current.value = "";
  }, []);
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
      {prefill ? <input ref={prefillMarker} type="hidden" name="prefill_unsaved" defaultValue="1" /> : null}
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
      {products ? <RequestedProductPicker orgId={orgId} initial={null} error={errors.requested_product_id} /> : null}
      <LeadChannelField value={values.preferred_channel ?? ""} error={errors.preferred_channel} />
      <LeadLocaleField value={values.preferred_locale ?? ""} error={errors.preferred_locale} />
      <LeadCampaignFields values={values} errors={errors} />
      <TextareaField
        label="הודעה או הערה ראשונה"
        name="message"
        rows={4}
        maxLength={5000}
        defaultValue={values.message}
        error={errors.message}
      />
      <CustomFieldInputs definitions={fields} submitted={failure?.values} errors={errors} objectType="lead" />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים ליד…">יצירת ליד</SubmitButton>
        <ButtonLink href={paths.leads(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}
