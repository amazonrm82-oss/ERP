"use client";

import { useActionState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createCompanyAction } from "../actions";
import { CompanyFields } from "./company-fields";

/** New company form. On success the action redirects to the company's page. */
export function CompanyForm({ orgId, fields }: { orgId: string; fields: FieldDefinition[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(createCompanyAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.message} />
      <CompanyFields values={failure?.values ?? {}} errors={failure?.fieldErrors ?? {}} />
      <CustomFieldInputs definitions={fields} submitted={failure?.values} errors={failure?.fieldErrors} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצר חברה…">יצירת חברה</SubmitButton>
        <ButtonLink href={paths.companies(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}
