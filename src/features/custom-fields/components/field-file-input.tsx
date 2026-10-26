"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { ACCEPT, FILES_BUCKET } from "@/features/files/types";
import { createClient } from "@/lib/supabase/client";

import { finishFieldFileAction, prepareFieldFileAction, removeFieldFileAction, type FieldFileTarget } from "../field-file-actions";
import type { FieldRef } from "../types";

type Props = {
  orgId: string;
  target: FieldFileTarget;
  label: string;
  // the field's current file (its name and link), null when empty; `held` = a value the page could not read
  current: FieldRef | null;
  held: boolean;
  // FLD-07: a read-only field that holds a file is locked
  locked: boolean;
  hint?: string;
};

/**
 * FLD-06 part B: a file field on an existing record. Uploading acts at once, like the record's files (the row, the object
 * with the user's session, the server's check), and the new file replaces the field's value; the old one is released by
 * the database. It sends nothing with the surrounding form.
 */
export function FieldFileInput({ orgId, target, label, current, held, locked, hint }: Props) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const prepared = await prepareFieldFileAction(orgId, target, { name: file.name, size: file.size, type: file.type || "application/octet-stream" });
    if (!prepared.ok) {
      setError(prepared.message);
    } else {
      const { error: uploadError } = await createClient().storage.from(FILES_BUCKET).upload(prepared.path, file, { contentType: file.type, upsert: false });
      const finished = await finishFieldFileAction(orgId, target, prepared.id, !uploadError);
      if (uploadError) setError(`ההעלאה של ${file.name} נכשלה. נסו שוב.`);
      else if (!finished.ok) setError(finished.message);
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  const filled = held || current !== null;
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        {current ? (
          current.href ? (
            <a href={current.href} className="break-all text-accent-strong underline underline-offset-4">
              {current.label}
            </a>
          ) : (
            <span className="break-all">{current.label}</span>
          )
        ) : held ? (
          <span>קובץ</span>
        ) : (
          <span className="text-ink-soft">אין קובץ</span>
        )}
        {locked ? null : (
          <label
            htmlFor={inputId}
            className={`inline-flex min-h-10 cursor-pointer items-center rounded-md px-3 text-sm font-medium text-accent-strong hover:bg-canvas focus-within:outline-2 ${busy ? "pointer-events-none opacity-60" : ""}`}
          >
            {busy ? "מעלים…" : filled ? "החלפת קובץ" : "צירוף קובץ"}
            <span className="sr-only">: {label}</span>
            <input ref={inputRef} id={inputId} type="file" accept={ACCEPT} disabled={busy} className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
        )}
        {filled && !locked ? (
          <ConfirmButton
            title="להסיר את הקובץ מהשדה?"
            description="הקובץ יימחק."
            confirmLabel="הסרה"
            action={() => removeFieldFileAction(orgId, target)}
            onDone={() => router.refresh()}
            disabled={busy}
          >
            הסרה
            <span className="sr-only">: {label}</span>
          </ConfirmButton>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {locked ? <p className="text-sm text-ink-soft">שדה לקריאה בלבד</p> : hint ? <p className="mt-1 text-sm text-ink-soft">{hint}</p> : null}
    </div>
  );
}
