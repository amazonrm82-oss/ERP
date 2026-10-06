"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addNoteAction } from "../actions";
import type { TimelineSubject } from "../schema";

export function NoteForm({ orgId, subject }: { orgId: string; subject: TimelineSubject }) {
  const [state, formAction] = useActionState<FormState, FormData>(addNoteAction.bind(null, orgId, subject), null);
  const failure = state && !state.ok ? state : null;

  return (
    // After a successful save React resets the form, which clears the textarea.
    <form action={formAction} className="space-y-3">
      <TextareaField
        label="הערה חדשה"
        name="body"
        rows={3}
        maxLength={5000}
        placeholder="מה סוכם? מה הצעד הבא?"
        defaultValue={failure?.values?.body}
        error={failure?.fieldErrors?.body}
      />
      {failure && !failure.fieldErrors ? <FormError message={failure.message} /> : null}
      <SubmitButton size="sm">הוספת הערה</SubmitButton>
    </form>
  );
}
