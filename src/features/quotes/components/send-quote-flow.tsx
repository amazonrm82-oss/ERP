"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, Input, Label } from "@/components/ui/field";

import { sendQuoteAction, type SentQuote } from "../actions";
import { QuoteShareButtons, type QuoteRecipient } from "./quote-share-buttons";

type Props = {
  orgId: string;
  quoteId: string;
  // false = no button (not a draft, or the user may not edit it); the window stays mounted, so the link made by
  // sending is still shown after the page refreshes as a sent quote
  canSend: boolean;
  businessName: string;
  recipient: QuoteRecipient;
};

/**
 * QUO-07 + QUO-08 (owner, 18 October 2026): "סימון כנשלחה" gives the draft its number and locks it, and by default also
 * makes the customer's link and offers the WhatsApp and email buttons right there.
 */
export function SendQuoteFlow({ orgId, quoteId, canSend, businessName, recipient }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [withLink, setWithLink] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentQuote | null>(null);
  const [pending, startTransition] = useTransition();

  function send() {
    setError(null);
    startTransition(async () => {
      const result = await sendQuoteAction(orgId, quoteId, withLink);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const data = result.data ?? { url: null, linkError: null, numberDisplay: null, pdfError: null };
      // QUO-06: a PDF that was not kept is said here, so the window stays open even without a link
      if (!withLink && !data.pdfError) {
        setOpen(false);
        return;
      }
      setSent(data);
    });
  }

  function close() {
    if (pending) return;
    setOpen(false);
    if (sent) {
      setSent(null);
      router.refresh();
    }
  }

  return (
    <>
      {canSend ? (
        <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
          סימון כנשלחה
        </Button>
      ) : null}
      <Dialog
        open={open}
        onClose={close}
        title={sent ? "ההצעה סומנה כנשלחה" : "לסמן את ההצעה כנשלחה?"}
        description={sent ? undefined : "ההצעה תקבל את המספר הרץ הבא, והיא ננעלת לעריכה."}
        footer={
          sent ? (
            <Button variant="secondary" autoFocus onClick={close}>
              סיום
            </Button>
          ) : (
            <>
              <Button variant="secondary" autoFocus onClick={close} disabled={pending}>
                ביטול
              </Button>
              <Button variant="primary" onClick={send} loading={pending}>
                סימון כנשלחה
              </Button>
            </>
          )
        }
      >
        {sent?.pdfError ? (
          <p className="mb-3 text-sm text-ink-soft">
            ההצעה סומנה כנשלחה, אבל קובץ ה-PDF שלה לא נשמר: {sent.pdfError} אפשר לשמור אותו אחר כך מדף ההצעה.
          </p>
        ) : null}
        {sent && !sent.url && !sent.linkError && sent.pdfError ? null : sent ? (
          sent.url ? (
            <div className="space-y-3">
              <Label htmlFor={inputId}>הקישור להצעה</Label>
              <Input id={inputId} dir="ltr" readOnly value={sent.url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
              <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. שלחו אותו ללקוח: מי שיש לו את הקישור רואה את ההצעה.</p>
              <QuoteShareButtons url={sent.url} numberDisplay={sent.numberDisplay} businessName={businessName} recipient={recipient} />
            </div>
          ) : (
            <div className="space-y-2">
              <FormError message={sent.linkError ?? "הקישור ללקוח לא נוצר."} />
              <p className="text-sm text-ink-soft">ההצעה סומנה כנשלחה. אפשר ליצור את הקישור בכרטיס &quot;קישור ללקוח&quot;.</p>
            </div>
          )
        ) : (
          <div className="space-y-3">
            <Checkbox
              label="ליצור קישור ללקוח ולשלוח אותו עכשיו"
              hint="אחרי הסימון יוצעו כפתורי WhatsApp ואימייל עם הקישור. בלי קישור אפשר לשלוח את ההצעה מודפסת או כקובץ PDF."
              checked={withLink}
              onChange={(event) => setWithLink(event.currentTarget.checked)}
              disabled={pending}
            />
            <FormError message={error} />
          </div>
        )}
      </Dialog>
    </>
  );
}
