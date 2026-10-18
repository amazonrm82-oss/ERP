"use client";

import { useActionState, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createTemplateAction, deleteTemplateAction, updateTemplateAction } from "../actions";
import type { ChecklistTemplate } from "../queries";
import { TEMPLATE_NAME_MAX, TEMPLATE_STEPS_MAX } from "../templates";

type FieldsProps = { values: { name?: string; steps?: string }; errors: Record<string, string> };

function TemplateFields({ values, errors }: FieldsProps) {
  return (
    <>
      <TextField label="שם התבנית" name="name" required maxLength={TEMPLATE_NAME_MAX} autoComplete="off" defaultValue={values.name} error={errors.name} />
      <TextareaField
        label="השלבים"
        name="steps"
        required
        rows={6}
        defaultValue={values.steps}
        error={errors.steps}
        hint={`שלב בכל שורה, עד ${TEMPLATE_STEPS_MAX} שלבים.`}
      />
    </>
  );
}

/** One template: its steps, and (owners and admins) editing and removing it. */
export function TemplateItem({ orgId, template, editable }: { orgId: string; template: ChecklistTemplate; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateTemplateAction(orgId, template.id, prev, formData);
    if (result?.ok) setEditing(false);
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  if (editing) {
    return (
      <form action={formAction} className="space-y-4" noValidate aria-label={`עריכת התבנית ${template.name}`}>
        <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
        <TemplateFields values={failure?.values ?? { name: template.name, steps: template.steps.join("\n") }} errors={failure?.fieldErrors ?? {}} />
        <div className="flex flex-wrap gap-2">
          <SubmitButton size="sm">שמירה</SubmitButton>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            ביטול
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-medium break-words">{template.name}</h3>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              עריכה
              <span className="sr-only">: {template.name}</span>
            </Button>
            <ActionButton
              action={deleteTemplateAction.bind(null, orgId, template.id)}
              pendingText="מוחקים…"
              variant="danger-ghost"
              confirm={`למחוק את התבנית "${template.name}"? משימות שכבר קיבלו את השלבים שלה לא משתנות.`}
              confirmLabel="מחיקת התבנית"
              srLabel={template.name}
            >
              מחיקה
            </ActionButton>
          </div>
        ) : null}
      </div>
      <ol className="list-decimal space-y-0.5 ps-6 text-md text-ink-soft">
        {template.steps.map((step, i) => (
          <li key={i} className="break-words">
            {step}
          </li>
        ))}
      </ol>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </div>
  );
}

/** A new template (owners and admins). The form clears itself after a successful save. */
export function NewTemplateForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(createTemplateAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TemplateFields values={failure?.values ?? {}} errors={failure?.fieldErrors ?? {}} />
      <SubmitButton pendingText="מוסיפים…">הוספת תבנית</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}
