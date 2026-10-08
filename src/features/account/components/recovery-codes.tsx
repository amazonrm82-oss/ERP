"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/app";

import { createRecoveryCodesAction } from "../actions";

/**
 * Backup codes for two-step verification: how many are left, and making new
 * ones. New codes are shown once, with copy and download.
 */
export function RecoveryCodes({ left }: { left: number }) {
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setError(null);
    setBusy(true);
    const result = await createRecoveryCodesAction();
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCodes(result.codes);
    setCopied(false);
  }

  const asText = (list: string[]) => `${APP_NAME}: קודי גיבוי לאימות דו-שלבי\nכל קוד עובד פעם אחת.\n\n${list.join("\n")}\n`;

  async function copy(list: string[]) {
    try {
      await navigator.clipboard.writeText(asText(list));
      setCopied(true);
    } catch {
      setError("ההעתקה לא הצליחה. סמנו את הקודים והעתיקו ידנית.");
    }
  }

  function download(list: string[]) {
    const url = URL.createObjectURL(new Blob([asText(list)], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${APP_NAME.toLowerCase()}-backup-codes.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (codes) {
    return (
      <div className="space-y-3 rounded-md border border-line p-4">
        <p className="font-medium">קודי הגיבוי החדשים שלך</p>
        <p className="text-sm text-ink-soft">
          אם תאבדו את הטלפון, כל קוד יכניס אתכם פעם אחת. שמרו אותם במקום בטוח שאינו הטלפון, למשל מודפסים או במנהל סיסמאות. הם לא יוצגו שוב.
        </p>
        <ul dir="ltr" aria-label="קודי גיבוי" className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-md">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copy(codes)}>
            {copied ? "הועתק" : "העתקה"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => download(codes)}>
            הורדה כקובץ
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setCodes(null);
              router.refresh();
            }}
          >
            שמרתי את הקודים
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="font-medium">קודי גיבוי</p>
      {left > 0 ? (
        <p className="text-sm text-ink-soft">נשארו {left} קודי גיבוי. כל קוד מכניס פעם אחת, אם אין גישה לאפליקציית האימות.</p>
      ) : (
        <p role="status" className="text-sm text-warning">
          אין לך קודי גיבוי. בלעדיהם, אם תאבדו את הטלפון, לא תוכלו להיכנס לחשבון. צרו אותם עכשיו ושמרו במקום בטוח.
        </p>
      )}
      {confirming ? (
        <span role="group" aria-label="אישור יצירת קודים חדשים" className="flex flex-wrap items-center gap-2">
          <span className="text-sm">הקודים הקודמים יפסיקו לעבוד.</span>
          <Button size="sm" disabled={busy} onClick={() => void create()}>
            {busy ? "יוצר…" : "יצירת קודים חדשים"}
          </Button>
          <Button variant="secondary" size="sm" autoFocus onClick={() => setConfirming(false)}>
            ביטול
          </Button>
        </span>
      ) : (
        <Button variant={left > 0 ? "secondary" : "primary"} disabled={busy} onClick={() => (left > 0 ? setConfirming(true) : void create())}>
          {busy ? "יוצר…" : left > 0 ? "יצירת קודים חדשים" : "יצירת קודי גיבוי"}
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
