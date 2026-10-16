"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import type { TimelineSubject } from "@/features/activities/schema";

import { ACCEPT } from "../types";
import { uploadFiles } from "../upload-client";

type Props = { orgId: string; subject: TimelineSubject; fileId: string; activityId: string | null; fileName: string };

/** REC-07: uploads a new version of a file; the earlier one stays in its history. */
export function NewVersionButton({ orgId, subject, fileId, activityId, fileName }: Props) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const problems = await uploadFiles(orgId, subject, [file], { previousId: fileId, activityId: activityId ?? undefined });
    setBusy(false);
    setError(problems[0] ?? null);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-start">
      <label
        htmlFor={inputId}
        className={`inline-flex min-h-10 cursor-pointer items-center rounded-md px-3 text-sm font-medium text-accent-strong hover:bg-canvas focus-within:outline-2 ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        {busy ? "מעלים…" : "גרסה חדשה"}
        <span className="sr-only">: {fileName}</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ACCEPT}
          disabled={busy}
          className="sr-only"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </label>
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
