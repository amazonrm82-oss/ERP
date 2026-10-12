"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { MentionCandidate } from "@/features/mentions/token";
import type { FormState } from "@/lib/action-result";

import { addNoteAction } from "../actions";
import { LOGGED_TYPES, PRIVATE_NOTE_HINT, type TimelineSubject } from "../schema";
import { NoteEditor } from "./note-editor";

export function NoteForm({ orgId, subject, mentions }: { orgId: string; subject: TimelineSubject; mentions?: MentionCandidate[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(addNoteAction.bind(null, orgId, subject), null);
  const failure = state && !state.ok ? state : null;

  return (
    // After a successful save React resets the form, which clears the textarea.
    <form action={formAction} className="space-y-3">
      <SelectField key={`type-${failure?.values?.type ?? "note"}`} label="סוג הפעילות" name="type" defaultValue={failure?.values?.type ?? "note"} className="max-w-48">
        {LOGGED_TYPES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <NoteEditor
        label="תיעוד"
        name="body"
        rows={3}
        maxLength={5000}
        placeholder="מה סוכם? מה הצעד הבא?"
        defaultValue={failure?.values?.body}
        error={failure?.fieldErrors?.body}
        mentions={mentions}
      />
      {/* GAP-05: a note only; the database refuses a private call or meeting */}
      <Checkbox
        key={`private-${failure?.values?.private ?? ""}`}
        name="private"
        label="הערה פרטית"
        hint={PRIVATE_NOTE_HINT}
        defaultChecked={failure?.values?.private === "on"}
      />
      {failure?.fieldErrors?.private ? <FormError message={failure.fieldErrors.private} /> : null}
      {failure && !failure.fieldErrors ? <FormError message={failure.message} /> : null}
      <SubmitButton size="sm">הוספה לציר הזמן</SubmitButton>
    </form>
  );
}
