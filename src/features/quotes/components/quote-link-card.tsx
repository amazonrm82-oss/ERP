"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";

import { createQuoteLinkAction, revokeQuoteLinkAction } from "../actions";

type Props = {
  orgId: string;
  quoteId: string;
  // the quote's number, for the WhatsApp message
  numberDisplay: string | null;
  active: boolean;
  // already formatted for the screen
  createdText: string;
};

/** The message that goes with the link in WhatsApp; the person picks the chat. */
export function quoteLinkMessage(url: string, numberDisplay: string | null): string {
  return `${numberDisplay ? `הצעת מחיר ${numberDisplay}` : "הצעת מחיר"}: ${url}`;
}

/**
 * QUO-08 (and QUO-07's link): the customer's link to a sent quote. The link is shown once, right after it is made
 * (only its hash is kept): copy it or send it in WhatsApp then. After that a new link replaces it, or it is turned off.
 */
export function QuoteLinkCard({ orgId, quoteId, numberDisplay, active, createdText }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setError(null);
    setCopied(false);
    const result = await createQuoteLinkAction(orgId, quoteId);
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

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError("ההעתקה לא הצליחה. סמנו את הקישור והעתיקו ידנית.");
    }
  }

  return (
    <Card aria-labelledby={`${inputId}-title`} className="mb-5">
      <CardHeader id={`${inputId}-title`} title="קישור ללקוח" />
      <CardBody className="space-y-3">
        {url ? (
          <div className="space-y-3">
            <Label htmlFor={inputId}>הקישור להצעה</Label>
            <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
            <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. שלחו אותו ללקוח עכשיו: מי שיש לו את הקישור רואה את ההצעה.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copy(url)}>
                {copied ? "הועתק" : "העתקת הקישור"}
              </Button>
              <a
                className={buttonClasses("secondary", "sm")}
                href={`https://wa.me/?text=${encodeURIComponent(quoteLinkMessage(url, numberDisplay))}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                שליחה ב-WhatsApp
                <span className="sr-only"> (נפתח בחלון חדש)</span>
              </a>
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
            <p className="text-md">יש להצעה קישור פעיל{createdText ? ` מאז ${createdText}` : ""}. הלקוח רואה בו את ההצעה כפי שנשלחה.</p>
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                variant="secondary"
                size="sm"
                title="ליצור קישור חדש?"
                description="הקישור הקודם יפסיק לעבוד מיד, ויהיה צריך לשלוח ללקוח את החדש."
                confirmLabel="יצירת קישור חדש"
                action={create}
              >
                קישור חדש
              </ConfirmButton>
              <ConfirmButton
                size="sm"
                title="לבטל את הקישור?"
                description="הלקוח לא יוכל לפתוח את ההצעה מהקישור ששלחתם."
                confirmLabel="ביטול הקישור"
                action={revokeQuoteLinkAction.bind(null, orgId, quoteId)}
                onDone={() => router.refresh()}
              >
                ביטול הקישור
              </ConfirmButton>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-md">קישור שהלקוח פותח בטלפון או במחשב, בלי להירשם, ורואה בו את ההצעה בעיצוב של העסק.</p>
            <Button size="sm" onClick={() => void createFirst()} loading={busy}>
              יצירת קישור ללקוח
            </Button>
          </div>
        )}
        <FormError message={error} />
      </CardBody>
    </Card>
  );
}
