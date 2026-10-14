"use client";

import { useActionState } from "react";

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

import { createContactAction } from "../actions";
import { ContactFields } from "./contact-fields";

/** New contact form. On success the action redirects to the contact's page. */
export function ContactForm({
  orgId,
  companies,
  fields,
  types,
  priceLists,
}: {
  orgId: string;
  companies: CompanyOption[];
  fields: FieldDefinition[];
  types: RecordType[];
  priceLists: BillingPriceList[];
}) {
  const [state, formAction] = useActionState<FormState, FormData>(createContactAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.message} />
      {failure?.fieldErrors?.allow_duplicate ? <DuplicateNotice href={failure.fieldErrors.allow_duplicate} createLabel="ליצור איש קשר חדש בכל זאת" /> : null}
      <ContactFields values={failure?.values ?? {}} errors={failure?.fieldErrors ?? {}} companies={companies} types={types} />
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
