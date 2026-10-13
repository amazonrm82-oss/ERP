"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormNotice } from "@/components/ui/feedback";

import { addSampleDataAction, removeSampleDataAction } from "../checklist-actions";
import { keptSampleMessage } from "../checklist";

// removable: untouched sample records; kept: sample records someone changed, which stay
type Props = { orgId: string; removable: number; kept: number };

/**
 * Sample data (USR-04): add a small set of records to see how the system looks,
 * and remove all of them in one click. Real records are never removed.
 */
export function SampleDataControls({ orgId, removable, kept }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function add() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await addSampleDataAction(orgId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNotice(result.message ?? null);
    });
  }

  return (
    <div className="space-y-2">
      {removable > 0 ? (
        <>
          <p className="text-sm text-ink-soft">
            {`יש במערכת ${removable} רשומות דוגמה. בשם של כל אחת מופיע "(דוגמה)".`}
          </p>
          <ConfirmButton
            variant="danger-ghost"
            size="sm"
            title="למחוק את נתוני הדוגמה?"
            description="רשומות הדוגמה יימחקו לצמיתות. רשומות אמיתיות, ורשומות דוגמה ששיניתם, לא נמחקות."
            confirmLabel="מחיקה"
            action={async () => {
              setNotice(null);
              const result = await removeSampleDataAction(orgId);
              if (result.ok) {
                setNotice(result.message ?? null);
              }
              return result;
            }}
          >
            מחיקת נתוני הדוגמה
          </ConfirmButton>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-soft">רוצים לראות איך זה נראה? אפשר להוסיף כמה לידים, אנשי קשר ועסקה לדוגמה, ולמחוק אותם בלחיצה.</p>
          <Button variant="secondary" size="sm" onClick={add} loading={pending}>
            הוספת נתוני דוגמה
          </Button>
        </>
      )}
      {kept > 0 ? <p className="text-sm text-ink-soft">{keptSampleMessage(kept)}</p> : null}
      <FormError message={error} />
      <FormNotice message={notice} />
    </div>
  );
}
