"use client";

import { useActionState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { DuplicateNotice } from "@/features/data-quality/components/duplicate-notice";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { RecordType } from "@/features/record-type-options/schema";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createCompanyAction } from "../actions";
import { CompanyFields } from "./company-fields";

/** New company form. On success the action redirects to the company's page. */
export function CompanyForm({ orgId, fields, types }: { orgId: string; fields: FieldDefinition[]; types: RecordType[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(createCompanyAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.message} />
      {failure?.fieldErrors?.allow_duplicate ? <DuplicateNotice href={failure.fieldErrors.allow_duplicate} createLabel="ליצור חברה חדשה בכל זאת" /> : null}
      <CompanyFields values={failure?.values ?? {}} errors={failure?.fieldErrors ?? {}} types={types} />
      <CustomFieldInputs definitions={fields} submitted={failure?.values} errors={failure?.fieldErrors} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים חברה…">יצירת חברה</SubmitButton>
        <ButtonLink href={paths.companies(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}
