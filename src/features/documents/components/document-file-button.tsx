"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import { DOCUMENT_ACCEPT, FILES_BUCKET } from "@/features/files/types";
import { createClient } from "@/lib/supabase/client";

import { finishDocumentFileAction, prepareDocumentFileAction } from "../file-actions";

type Props = {
  orgId: string;
  subject: { kind: "deal" | "contact"; id: string };
  documentId: string;
  // the newest file of the document (a new one replaces it), null when it has none
  latestId: string | null;
  // what the document is called, for screen readers
  label: string;
};

/**
 * DOC-01 follow-up: attaches the document's file (a PDF or an image), or a new version of it; the earlier one stays in its
 * history. A row on the server first (rights, type, storage, link to the latest file), then the object straight to Storage
 * with the user's session, then the server checks what arrived.
 */
export function DocumentFileButton({ orgId, subject, documentId, latestId, label }: Props) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const prepared = await prepareDocumentFileAction(orgId, subject, documentId, { name: file.name, size: file.size, type: file.type || "application/octet-stream" }, latestId);
    if (!prepared.ok) {
      setError(prepared.message);
    } else {
      const { error: uploadError } = await createClient().storage.from(FILES_BUCKET).upload(prepared.path, file, { contentType: file.type, upsert: false });
      const finished = await finishDocumentFileAction(orgId, subject, prepared.id, !uploadError);
      if (uploadError) setError(`ההעלאה של ${file.name} נכשלה. נסו שוב.`);
      else if (!finished.ok) setError(finished.message);
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-start">
      <label
        htmlFor={inputId}
        className={`inline-flex min-h-10 cursor-pointer items-center rounded-md px-3 text-sm font-medium text-accent-strong hover:bg-canvas focus-within:outline-2 ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        {busy ? "מעלים…" : latestId ? "קובץ חדש" : "צירוף קובץ"}
        <span className="sr-only">: {label} (PDF או תמונה)</span>
        <input ref={inputRef} id={inputId} type="file" accept={DOCUMENT_ACCEPT} disabled={busy} className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
      </label>
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
