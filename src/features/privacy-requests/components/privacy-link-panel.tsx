"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";

import { createPrivacyLinkAction, revokePrivacyLinkAction } from "../actions";

type Props = { orgId: string; active: boolean; createdText: string; pagesOpen: boolean };

/**
 * PRK-02: the business's link to its public privacy-request page. Shown once, right after it is made (only its hash is
 * kept): copy it into the privacy notice then. After that a new link replaces it, or it is turned off.
 */
export function PrivacyLinkPanel({ orgId, active, createdText, pagesOpen }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    setError(null);
    setCopied(false);
    const result = await createPrivacyLinkAction(orgId);
    if (!result.ok) return result;
    setUrl(result.data?.url ?? null);
    return { ok: true as const };
  }

  async function createFirst() {
    setBusy(true);
    const result = await create();
    setBusy(false);
    if (!result.ok) setError(result.message);
  }

  async function copy(text: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("ההעתקה לא הצליחה. סמנו את הקישור והעתיקו ידנית.");
    }
  }

  return (
    <div className="space-y-3">
      {!pagesOpen ? <p className="text-sm text-ink-soft">העסק אינו פעיל כרגע, ולכן הדף לא נפתח למי שמקבל את הקישור.</p> : null}
      {url ? (
        <div className="space-y-3">
          <Label htmlFor={inputId}>הקישור לבקשות פרטיות</Label>
          <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
          <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. העתיקו אותו להודעת הפרטיות של העסק ולאתר.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copy(url)}>
              {copied ? "הועתק" : "העתקת הקישור"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setUrl(null);
                router.refresh();
              }}
            >
              סיום
            </Button>
          </div>
        </div>
      ) : active ? (
        <div className="space-y-3">
          <p className="text-sm">יש לעסק קישור פעיל לבקשות פרטיות{createdText ? ` מאז ${createdText}` : ""}.</p>
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              variant="secondary"
              size="sm"
              title="ליצור קישור חדש?"
              description="הקישור הקודם יפסיק לעבוד מיד. צריך להחליף אותו בהודעת הפרטיות ובאתר."
              confirmLabel="יצירת קישור חדש"
              action={create}
            >
              קישור חדש
            </ConfirmButton>
            <ConfirmButton
              size="sm"
              title="לבטל את הקישור?"
              description="מי שיפתח את הקישור לא יוכל לשלוח בקשה."
              confirmLabel="ביטול הקישור"
              action={revokePrivacyLinkAction.bind(null, orgId)}
              onDone={() => router.refresh()}
            >
              ביטול הקישור
            </ConfirmButton>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            דף שבו אנשים מבקשים לעיין במידע שהעסק שומר עליהם, לתקן אותו או למחוק אותו. שמים את הקישור בהודעת הפרטיות של העסק.
          </p>
          <Button size="sm" variant="secondary" onClick={() => void createFirst()} loading={busy}>
            יצירת קישור
          </Button>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}
