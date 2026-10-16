"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addNoteAction } from "../actions";
import { PRIVATE_NOTE_HINT, type TimelineSubject } from "../schema";

/**
 * A short note right under the call buttons (FXU-03): after a call on the
 * phone, the summary is one tap away instead of below everything. It lands in
 * the timeline like any note.
 */
export function QuickNote({ orgId, subject, className }: { orgId: string; subject: TimelineSubject; className?: string }) {
  const [state, formAction] = useActionState<FormState<{ id: string }>, FormData>(addNoteAction.bind(null, orgId, subject), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className={className}>
      <input type="hidden" name="type" value="note" />
      <TextareaField
        label="הערה קצרה"
        name="body"
        rows={2}
        maxLength={5000}
        placeholder="מה סוכם בשיחה?"
        defaultValue={failure?.values?.body}
        error={failure?.fieldErrors?.body}
      />
      {/* GAP-05 */}
      <Checkbox
        key={`private-${failure?.values?.private ?? ""}`}
        name="private"
        label="הערה פרטית"
        hint={PRIVATE_NOTE_HINT}
        defaultChecked={failure?.values?.private === "on"}
        className="mt-2"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingText="שומרים…">
          שמירת ההערה
        </SubmitButton>
        <FormNotice message={state?.ok ? "ההערה נשמרה בציר הזמן." : null} className="py-1.5" />
      </div>
      {failure?.fieldErrors?.private ? <FormError message={failure.fieldErrors.private} className="mt-2" /> : null}
      {failure && !failure.fieldErrors ? <FormError message={failure.message} className="mt-2" /> : null}
    </form>
  );
}
