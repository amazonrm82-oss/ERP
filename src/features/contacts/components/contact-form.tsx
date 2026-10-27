"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { CompanyOption } from "@/features/companies/queries";
import { DuplicateNotice } from "@/features/data-quality/components/duplicate-notice";
import { BillingSection } from "@/features/billing/components/billing-fields";
import type { BillingPriceList } from "@/features/billing/queries";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { RecordType } from "@/features/record-type-options/schema";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createContactAction, createContactStayAction } from "../actions";
import type { NewContact } from "../actions";
import { ContactFields } from "./contact-fields";

/** New contact form. On success the action redirects to the contact's page. */
export function ContactForm({
  orgId,
  companies,
  fields,
  types,
  priceLists,
  prefill,
  onCreated,
}: {
  orgId: string;
  // LEAD-08: null = the companies module is switched off (no picker; the stored company is kept)
  companies: CompanyOption[] | null;
  fields: FieldDefinition[];
  types: RecordType[];
  priceLists: BillingPriceList[];
  // WAB-06: starting values from something shared to the app (phone, email); still editable
  prefill?: Record<string, string>;
  // WAB-06: called with the new contact instead of going to its page (the share screen saves a note on it first)
  onCreated?: (created: NewContact) => void;
}) {
  // which action is fixed when the form mounts (the share screen always passes onCreated)
  const [stay] = useState(() => onCreated !== undefined);
  const [state, formAction] = useActionState<FormState<NewContact>, FormData>(
    stay ? createContactStayAction.bind(null, orgId) : (createContactAction.bind(null, orgId) as (prev: FormState<NewContact>, form: FormData) => Promise<FormState<NewContact>>),
    null,
  );
  const failure = state && !state.ok ? state : null;
  const values = failure?.values ?? prefill ?? {};
  // WAB-06: prefilled values are not saved yet; as in LeadForm, this marker is emptied after FormGuard takes its starting
  // point, so leaving a prefilled form asks first
  const prefillMarker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (prefillMarker.current) prefillMarker.current.value = "";
  }, []);
  const created = useRef(onCreated);
  useEffect(() => {
    created.current = onCreated;
  });
  const answer = state?.ok ? state.data : undefined;
  useEffect(() => {
    if (answer) created.current?.(answer);
  }, [answer]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      {prefill ? <input ref={prefillMarker} type="hidden" name="prefill_unsaved" defaultValue="1" /> : null}
      <FormError message={failure?.message} />
      {failure?.fieldErrors?.allow_duplicate ? <DuplicateNotice href={failure.fieldErrors.allow_duplicate} createLabel="ליצור איש קשר חדש בכל זאת" /> : null}
      <ContactFields values={values} errors={failure?.fieldErrors ?? {}} companies={companies} types={types} />
      <CustomFieldInputs definitions={fields} submitted={failure?.values} errors={failure?.fieldErrors} objectType="contact" />
      <BillingSection subject="contact" values={failure?.values ?? {}} errors={failure?.fieldErrors ?? {}} priceLists={priceLists} fromCompanyHint />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים איש קשר…">יצירת איש קשר</SubmitButton>
        <ButtonLink href={paths.contacts(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}
