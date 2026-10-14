"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";
import type { ActionResult, FormState } from "@/lib/action-result";

import { isMoveRefusal, type MoveRefusal } from "../required-move";
import type { FieldDefinition } from "../types";
import { AskedFields } from "./asked-fields";

// FLD-09 (owner, 14 October 2026): a move on the board, in the board card's menu or in a table cell that
// would leave conditionally required fields empty asks for them here, and saves them with the move.
export type RequiredAsk = {
  object: "lead" | "deal";
  // what is moving and where to ("הליד דנה כהן עובר לסטטוס נסגר")
  description: string;
  fields: FieldDefinition[];
  // a lead moving to "not relevant": the reason it was given; asked here again when it does not pass
  // (error set, or the save says so), so a save never fails on a reason the window had no input for
  reason?: { reasons: string[]; label: string; value: string; error?: string };
  // saves the move with the values (one update, moveRecordAction); field errors come back to the form
  save: (formData: FormData) => Promise<ActionResult | MoveRefusal>;
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
  const [reason, setReason] = useState(ask.reason?.value ?? "");
  // once shown, the reason stays in the window (it is sent from here from then on)
  const [askReason, setAskReason] = useState(ask.reason?.error !== undefined);
  const [state, formAction] = useActionState<FormState, FormData>(async (_prev, formData) => {
    const result = await ask.save(formData);
    if (result.ok) {
      onClose();
      ask.onSaved?.();
    } else if (result.fieldErrors?.disqualify_reason) {
      setAskReason(true);
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  // the server may name other fields by now (a field's settings changed): it wins
  const fields = isMoveRefusal(state) ? state.missing : ask.fields;
  const reasonError = failure ? failure.fieldErrors?.disqualify_reason : ask.reason?.error;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      {askReason && ask.reason ? (
        <DisqualifyReasonField reasons={ask.reason.reasons} label={ask.reason.label} name="disqualify_reason" value={reason} onChange={setReason} error={reasonError} />
      ) : null}
      <AskedFields object={ask.object} fields={fields} submitted={failure?.values} errors={failure?.fieldErrors} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">שמירה והעברה</SubmitButton>
        <Button variant="ghost" onClick={onClose}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
