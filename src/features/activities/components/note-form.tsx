"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useRef, useState } from "react";

import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { MentionCandidate } from "@/features/mentions/token";
import { ACCEPT } from "@/features/files/types";
import { uploadFiles } from "@/features/files/upload-client";
import type { FormState } from "@/lib/action-result";

import { addNoteAction } from "../actions";
import { LOGGED_TYPES, PRIVATE_NOTE_HINT, type TimelineSubject } from "../schema";
import { NoteEditor } from "./note-editor";

export function NoteForm({ orgId, subject, mentions }: { orgId: string; subject: TimelineSubject; mentions?: MentionCandidate[] }) {
  const router = useRouter();
  const fileInputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  // REC-07: files to attach, kept apart from the form (the input has no name, so they never go to the action)
  const [files, setFiles] = useState<File[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [state, formAction] = useActionState<FormState<{ id: string }>, FormData>(async (prev, formData) => {
    const result = await addNoteAction(orgId, subject, prev, formData);
    if (result?.ok && result.data && files.length > 0) {
      // the note is saved first; then each file is uploaded onto it
      setUploadErrors(await uploadFiles(orgId, subject, files, { activityId: result.data.id }));
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    }
    return result;
  }, null);
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
      {/* REC-07: files on the entry, seen by whoever sees the entry */}
      <div>
        <label htmlFor={fileInputId} className="text-sm font-medium">
          צירוף קבצים
        </label>
        <input
          ref={fileInput}
          id={fileInputId}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="mt-1 block w-full text-sm text-ink-soft file:me-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        />
        <p className="mt-1 text-xs text-ink-soft">עד 25 MB לקובץ. הקבצים מוצגים גם בכרטיס הקבצים של הרשומה.</p>
      </div>
      {failure && !failure.fieldErrors ? <FormError message={failure.message} /> : null}
      {uploadErrors.length ? (
        <ul role="alert" className="space-y-1 text-sm text-danger">
          {uploadErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <SubmitButton size="sm">הוספה לציר הזמן</SubmitButton>
    </form>
  );
}
