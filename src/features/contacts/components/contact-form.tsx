"use client";

import { useActionState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { CompanyOption } from "@/features/companies/queries";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createContactAction } from "../actions";
import { ContactFields } from "./contact-fields";

/** New contact form. On success the action redirects to the contact's page. */
export function ContactForm({ orgId, companies, fields }: { orgId: string; companies: CompanyOption[]; fields: FieldDefinition[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(createContactAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.message} />
      <ContactFields values={failure?.values ?? {}} errors={failure?.fieldErrors ?? {}} companies={companies} />
      <CustomFieldInputs definitions={fields} submitted={failure?.values} errors={failure?.fieldErrors} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים איש קשר…">יצירת איש קשר</SubmitButton>
        <ButtonLink href={paths.contacts(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}
