"use client";

import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { deleteNoteAction, updateNoteAction } from "../actions";
import type { TimelineSubject } from "../schema";
import { NoteEditor } from "./note-editor";

type Props = {
  orgId: string;
  subject: TimelineSubject;
  activityId: string;
  // what the entry is ("הערה", "שיחה"), so a screen reader knows which one a button acts on
  label: string;
  // the stored text, for the edit box
  body: string;
};

/**
 * REC-05: edit or delete an entry a person logged. Shown to its author for 24 hours and to
 * owners/admins; the database enforces the same rule and writes the change to the audit log.
 */
export function NoteActions({ orgId, subject, activityId, label, body }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        עריכה
        <span className="sr-only">: {label}</span>
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`עריכה: ${label}`} variant="sheet">
        {open ? <EditNoteForm orgId={orgId} subject={subject} activityId={activityId} body={body} onDone={() => setOpen(false)} /> : null}
      </Dialog>
      <ConfirmButton
        title="למחוק מציר הזמן?"
        description="המחיקה סופית, ונרשמת ביומן הביקורת."
        confirmLabel="מחיקה"
        action={deleteNoteAction.bind(null, orgId, subject, activityId)}
      >
        מחיקה
        <span className="sr-only">: {label}</span>
      </ConfirmButton>
    </>
  );
}

function EditNoteForm({ orgId, subject, activityId, body, onDone }: { orgId: string; subject: TimelineSubject; activityId: string; body: string; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(updateNoteAction.bind(null, orgId, subject, activityId), null);
  const failure = state && !state.ok ? state : null;

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <NoteEditor
        label="הטקסט"
        name="body"
        rows={5}
        maxLength={5000}
        defaultValue={failure?.values?.body ?? body}
        error={failure?.fieldErrors?.body}
        autoFocus
      />
      {failure && !failure.fieldErrors ? <FormError message={failure.message} /> : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">שמירת השינוי</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
