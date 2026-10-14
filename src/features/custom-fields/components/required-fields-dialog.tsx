"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult, FormState } from "@/lib/action-result";

import type { FieldDefinition } from "../types";
import { CustomFieldInputs } from "./custom-field-inputs";

// FLD-09 (owner, 14 October 2026): a move on the board or in a table cell that would leave
// conditionally required fields empty asks for them here, and saves them with the move.
export type RequiredAsk = {
  // what is moving and where to ("הליד דנה כהן עובר לסטטוס נסגר")
  description: string;
  fields: FieldDefinition[];
  // saves the move with the values (one update); field errors come back to the form
  save: (formData: FormData) => Promise<ActionResult>;
  // after a save
  onSaved?: () => void;
};

/** The window. Cancel saves nothing: the record stays where it was. */
export function RequiredFieldsDialog({ ask, onClose }: { ask: RequiredAsk | null; onClose: () => void }) {
  return (
    <Dialog open={ask !== null} onClose={onClose} title="כדי להעביר, צריך למלא" description={ask?.description} variant="sheet">
      {ask ? <AskForm key={ask.description} ask={ask} onClose={onClose} /> : null}
    </Dialog>
  );
}

function AskForm({ ask, onClose }: { ask: RequiredAsk; onClose: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (_prev, formData) => {
    const result = await ask.save(formData);
    if (result.ok) {
      onClose();
      ask.onSaved?.();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <p className="text-sm text-ink-soft">בשלב הזה השדות האלה הם חובה. הם נשמרים יחד עם ההעברה.</p>
      <CustomFieldInputs definitions={ask.fields} submitted={failure?.values} errors={failure?.fieldErrors} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">שמירה והעברה</SubmitButton>
        <Button variant="ghost" onClick={onClose}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
