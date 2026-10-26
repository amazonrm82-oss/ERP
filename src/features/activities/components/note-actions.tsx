"use client";

import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { MentionCandidate } from "@/features/mentions/token";
import type { FormState } from "@/lib/action-result";

import { deleteImportNoteAction, deleteNoteAction, updateNoteAction } from "../actions";
import { PRIVATE_NOTE_HINT, PRIVATE_NOTE_TYPE, type TimelineSubject } from "../schema";
import { NoteEditor } from "./note-editor";

type Props = {
  orgId: string;
  subject: TimelineSubject;
  activityId: string;
  // what the entry is ("הערה", "שיחה"), so a screen reader knows which one a button acts on
  label: string;
  // the stored text, for the edit box
  body: string;
  // GAP-05: a note can be made private or public in the edit box
  type: string;
  isPrivate: boolean;
  // REC-02: who may be mentioned in the edit box
  mentions?: MentionCandidate[];
};

/**
 * REC-05: edit or delete an entry a person logged. Shown to its author for 24 hours and to
 * owners/admins; the database enforces the same rule and writes the change to the audit log.
 */
export function NoteActions({ orgId, subject, activityId, label, body, type, isPrivate, mentions }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        עריכה
        <span className="sr-only">: {label}</span>
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`עריכה: ${label}`} variant="sheet">
        {open ? <EditNoteForm
            orgId={orgId}
            subject={subject}
            activityId={activityId}
            body={body}
            privacy={type === PRIVATE_NOTE_TYPE ? isPrivate : null}
            mentions={mentions}
            onDone={() => setOpen(false)}
          /> : null}
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

type EditProps = {
  orgId: string;
  subject: TimelineSubject;
  activityId: string;
  body: string;
  // GAP-05: whether the note is private now; null for an entry that cannot be private (a call, a meeting)
  privacy: boolean | null;
  mentions?: MentionCandidate[];
  onDone: () => void;
};

function EditNoteForm({ orgId, subject, activityId, body, privacy, mentions, onDone }: EditProps) {
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
        mentions={mentions}
      />
      {privacy !== null ? (
        <>
          <input type="hidden" name="private_field" value="1" />
          <Checkbox
            name="private"
            label="הערה פרטית"
            hint={PRIVATE_NOTE_HINT}
            defaultChecked={failure?.values ? failure.values.private === "on" : privacy}
          />
        </>
      ) : null}
      {failure?.fieldErrors?.private ? <FormError message={failure.fieldErrors.private} /> : null}
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

/** GAP-12: an owner or admin removes a wrong note an import wrote (no editing: it is the file's text). */
export function ImportNoteRemove({ orgId, subject, activityId, label }: Pick<Props, "orgId" | "subject" | "activityId" | "label">) {
  return (
    <ConfirmButton
      title="למחוק את ההערה מהייבוא?"
      description="המחיקה סופית, ונרשמת ביומן הביקורת."
      confirmLabel="מחיקה"
      action={deleteImportNoteAction.bind(null, orgId, subject, activityId)}
    >
      מחיקה
      <span className="sr-only">: {label}</span>
    </ConfirmButton>
  );
}
