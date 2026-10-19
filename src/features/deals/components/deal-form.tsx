"use client";

import { useActionState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createDealAction } from "../actions";
import type { StageOption } from "../queries";
import { RecurringFields } from "./recurring-fields";

type Props = {
  orgId: string;
  // the pipeline the stages belong to (a pipeline condition of a custom field reads it)
  pipelineId: string;
  stages: StageOption[];
  contacts: Array<{ id: string; name: string }>;
  // LEAD-08: null = the companies module is switched off (no picker; the stored company is kept)
  companies: Array<{ id: string; name: string }> | null;
  // preselected when the form is opened from a contact's or a company's page
  defaultContactId: string;
  defaultCompanyId: string;
  fields: FieldDefinition[];
};

/** New deal form. On success the action redirects to the board. */
export function DealForm({ orgId, pipelineId, stages, contacts, companies, defaultContactId, defaultCompanyId, fields }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(createDealAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values ?? {};
  const errors = failure?.fieldErrors ?? {};

  const stageValue = values.stage_id ?? stages.find((stage) => stage.kind === "open")?.id ?? stages[0]?.id ?? "";
  const contactValue = values.contact_id ?? defaultContactId;
  const companyValue = values.company_id ?? defaultCompanyId;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <input type="hidden" name="pipeline_id" value={pipelineId} />
      <FormError message={failure?.message} />
      <TextField
        label="שם העסקה"
        name="name"
        required
        maxLength={200}
        autoComplete="off"
        placeholder="למשל: חבילת ליווי שנתית"
        defaultValue={values.name}
        error={errors.name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="שווי (₪)"
          name="amount"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          defaultValue={values.amount}
          error={errors.amount}
          hint="שדה ריק יחושב לפי שורות המוצר שתוסיפו, או בעסקה חוזרת לפי שנה ראשונה."
        />
        <SelectField key={`stage-${stageValue}`} label="שלב" name="stage_id" required defaultValue={stageValue} error={errors.stage_id}>
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          key={`contact-${contactValue}`}
          label="איש קשר"
          name="contact_id"
          defaultValue={contactValue}
          error={errors.contact_id}
          hint={contacts.length === 0 ? "עוד אין אנשי קשר. אפשר לקשר אחד מאוחר יותר." : undefined}
        >
          <option value="">ללא איש קשר</option>
          {contacts.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name}
            </option>
          ))}
        </SelectField>
        {companies ? (
          <SelectField key={`company-${companyValue}`} label="חברה" name="company_id" defaultValue={companyValue} error={errors.company_id}>
            <option value="">ללא חברה</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </SelectField>
        ) : (
          <input type="hidden" name="company_id" value={companyValue} />
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="תאריך סגירה צפוי"
          name="expected_close_date"
          type="date"
          defaultValue={values.expected_close_date}
          error={errors.expected_close_date}
        />
      </div>
      <RecurringFields initial={{ kind: null, amount: "", start: "", renewal: "" }} submitted={failure?.values} errors={errors} />
      <CustomFieldInputs definitions={fields} submitted={failure?.values} errors={errors} objectType="deal" />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים עסקה…">יצירת עסקה</SubmitButton>
        <ButtonLink href={paths.deals(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}
