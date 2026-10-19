"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";

import { createQuoteLinkAction, revokeQuoteLinkAction } from "../actions";
import { NEW_LINK_WARNING } from "../share";
import { QuoteShareButtons, type QuoteRecipient } from "./quote-share-buttons";

type Props = {
  orgId: string;
  quoteId: string;
  // the quote's number, for the WhatsApp message
  numberDisplay: string | null;
  active: boolean;
  // already formatted for the screen
  createdText: string;
  // the business's display name and the customer, for the WhatsApp and email messages
  businessName: string;
  recipient: QuoteRecipient;
};

/**
 * QUO-08 (and QUO-07's link): the customer's link to a sent quote. The link is shown once, right after it is made
 * (only its hash is kept): copy it or send it in WhatsApp or by email then. After that a new link replaces it (the old one
 * stops working, and the person is told so first), or it is turned off.
 */
export function QuoteLinkCard({ orgId, quoteId, numberDisplay, active, createdText, businessName, recipient }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setError(null);
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

  return (
    <Card aria-labelledby={`${inputId}-title`} className="mb-5">
      <CardHeader id={`${inputId}-title`} title="קישור ללקוח" />
      <CardBody className="space-y-3">
        {url ? (
          <div className="space-y-3">
            <Label htmlFor={inputId}>הקישור להצעה</Label>
            <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
            <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. שלחו אותו ללקוח עכשיו: מי שיש לו את הקישור רואה את ההצעה.</p>
            <QuoteShareButtons url={url} numberDisplay={numberDisplay} businessName={businessName} recipient={recipient} />
            <div>
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
                description={NEW_LINK_WARNING}
                confirmLabel="יצירת קישור חדש"
                action={create}
              >
                קישור חדש
              </ConfirmButton>
              <ConfirmButton
                size="sm"
                title="לבטל את הקישור?"
                // QUO-12 (owner, 19 October 2026): an older version's link still leads to the newest sent version
                description="הלקוח לא יוכל לפתוח את ההצעה מהקישור הזה. קישורים שנשלחו לגרסאות קודמות של ההצעה עדיין מובילים אליה; כדי לחסום גם אותם, בטלו את הקישור בכל גרסה קודמת."
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
