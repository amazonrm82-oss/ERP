"use client";

import Link from "next/link";
import { useActionState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createLeadAction } from "../actions";
import type { LeadSourceOption, LeadStatusOption } from "../queries";

type Props = { orgId: string; statuses: LeadStatusOption[]; sources: LeadSourceOption[]; fields: FieldDefinition[] };

/** New lead form. On success the action redirects to the lead's page. */
export function LeadForm({ orgId, statuses, sources, fields }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(createLeadAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values ?? {};
  const errors = failure?.fieldErrors ?? {};

  // a new lead cannot start as "converted"
  const selectable = statuses.filter((status) => status.kind !== "converted");
  const defaultStatus = values.status_id ?? selectable.find((status) => status.isDefault)?.id ?? selectable[0]?.id ?? "";
  const manualSource = values.source_id ?? "";

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.message} />
      {errors.allow_duplicate ? (
        <div className="space-y-2 rounded-md border border-line p-3">
          <Link href={errors.allow_duplicate} className="text-md font-medium text-accent underline underline-offset-4">
            לפתוח את הרשומה הקיימת
          </Link>
          <label className="flex items-center gap-2.5 text-md">
            <input type="checkbox" name="allow_duplicate" className="size-4.5 accent-accent" />
            ליצור ליד חדש בכל זאת
          </label>
        </div>
      ) : null}
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
        <TextField
          label="טלפון"
          name="phone"
          type="tel"
          dir="ltr"
          inputMode="tel"
          autoComplete="off"
          defaultValue={values.phone}
          error={errors.phone}
        />
        <TextField
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
          key={`status-${defaultStatus}`}
          label="סטטוס"
          name="status_id"
          required
          defaultValue={defaultStatus}
          error={errors.status_id}
        >
          {selectable.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>
      </div>
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
