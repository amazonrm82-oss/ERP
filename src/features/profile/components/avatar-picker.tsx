"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { createClient } from "@/lib/supabase/client";

import { removeAvatarAction, setAvatarAction } from "../actions";
import { AVATAR_TYPES, AVATARS_BUCKET, avatarFileProblem } from "../avatar";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0])
    .join("");
}

/** Profile photo: upload straight to the user's own folder, then make it the photo. */
export function AvatarPicker({ orgId, userId, name, url }: { orgId: string; userId: string; name: string; url: string | null }) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    setStatus(null);
    const problem = avatarFileProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const path = `${userId}/${crypto.randomUUID()}`;
    const { error: uploadError } = await supabase.storage.from(AVATARS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      setBusy(false);
      setError("ההעלאה נכשלה. נסו שוב.");
      return;
    }
    const result = await setAvatarAction(orgId, path);
    if (!result.ok) {
      await supabase.storage.from(AVATARS_BUCKET).remove([path]);
      setError(result.message);
    } else {
      setStatus("התמונה עודכנה.");
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
        <img src={url} alt="התמונה שלך" className="size-20 shrink-0 rounded-full border border-line object-cover" />
      ) : (
        <span aria-hidden="true" className="flex size-20 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xl font-semibold text-accent-strong">
          {initials(name) || "?"}
        </span>
      )}
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={inputId}
            className={`inline-flex min-h-9 cursor-pointer items-center rounded-md border border-line-strong bg-surface px-3 text-sm font-medium hover:bg-canvas focus-within:outline-2 ${busy ? "pointer-events-none opacity-60" : ""}`}
          >
            {busy ? "מעלים…" : url ? "החלפת תמונה" : "העלאת תמונה"}
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept={AVATAR_TYPES.join(",")}
              disabled={busy}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          {url ? (
            <ConfirmButton
              title="להסיר את התמונה?"
              confirmLabel="הסרה"
              action={removeAvatarAction.bind(null, orgId)}
              onDone={() => router.refresh()}
              disabled={busy}
            >
              הסרת התמונה
            </ConfirmButton>
          ) : null}
        </div>
        <p className="text-sm text-ink-soft">JPG, PNG או WebP, עד 2 MB. רק אנשים בעסקים שלכם רואים אותה.</p>
        <p role="status" className="text-sm text-ink-soft">
          {status}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
