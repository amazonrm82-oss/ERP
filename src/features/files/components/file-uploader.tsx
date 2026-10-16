"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import type { TimelineSubject } from "@/features/activities/schema";
import { ACCEPT } from "../types";
import { uploadFiles } from "../upload-client";

/** Drop zone and file picker. Each file: a row on the server, then a direct upload to Storage. */
export function FileUploader({ orgId, subject }: { orgId: string; subject: TimelineSubject }) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function upload(list: FileList | File[]) {
    const files = Array.from(list);
    if (files.length === 0) return;
    setBusy(true);
    setErrors([]);
    const problems = await uploadFiles(orgId, subject, files, {}, (index, file) => setStatus(`מעלה ${index + 1} מתוך ${files.length}: ${file.name}`));
    setBusy(false);
    setStatus(problems.length === files.length ? null : "הקבצים הועלו.");
    setErrors(problems);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) void upload(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-5 text-center ${dragging ? "border-accent bg-accent-soft" : "border-line-strong"}`}
      >
        <p className="text-md text-ink-soft">גררו לכאן קבצים, או</p>
        <label
          htmlFor={inputId}
          className={`inline-flex min-h-10 cursor-pointer items-center rounded-md border border-line-strong bg-surface px-4 text-md font-medium hover:bg-canvas focus-within:outline-2 ${busy ? "pointer-events-none opacity-60" : ""}`}
        >
          בחירת קבצים
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            multiple
            accept={ACCEPT}
            disabled={busy}
            className="sr-only"
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
        </label>
        <p className="text-xs text-ink-soft">עד 25 MB לקובץ. PDF, תמונות, Word, Excel, PowerPoint, טקסט, CSV ו-ZIP.</p>
      </div>
      <p role="status" className="mt-2 text-sm text-ink-soft">
        {status}
      </p>
      {errors.length ? (
        <ul role="alert" className="mt-1 space-y-1 text-sm text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
