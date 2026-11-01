"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";

import { createStatementLinkAction, revokeStatementLinkAction, type StatementCustomer } from "../link-actions";
import { statementMailtoHref, statementWhatsappHref } from "../share";

type Props = {
  orgId: string;
  customer: StatementCustomer;
  active: boolean;
  // already formatted for the screen
  createdText: string;
  businessName: string;
  recipient: { name: string | null; phoneE164: string | null; email: string | null };
};

/**
 * BAL-04: the customer's statement link. Shown once, right after it is made (only its hash is kept): copy it or send it then.
 * After that a new link replaces it (the old one stops working), or it is turned off.
 */
export function StatementLinkPanel({ orgId, customer, active, createdText, businessName, recipient }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    setError(null);
    setCopied(false);
    const result = await createStatementLinkAction(orgId, customer);
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
      {url ? (
        <div className="space-y-3">
          <Label htmlFor={inputId}>הקישור לדף החשבון</Label>
          <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
          <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. שלחו אותו ללקוח: מי שיש לו את הקישור רואה את החובות הפתוחים.</p>
          <div className="flex flex-wrap gap-2">
            <a className={buttonClasses("secondary", "sm")} href={statementWhatsappHref(url, businessName, recipient.name, recipient.phoneE164)} target="_blank" rel="noopener noreferrer">
              שליחה ב-WhatsApp
              <span className="sr-only"> (נפתח בחלון חדש)</span>
            </a>
            <a className={buttonClasses("secondary", "sm")} href={statementMailtoHref(url, businessName, recipient.name, recipient.email)}>
              שליחה באימייל
            </a>
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
          <p className="text-sm">יש ללקוח קישור פעיל לדף חשבון{createdText ? ` מאז ${createdText}` : ""}. הלקוח רואה בו את החובות הפתוחים, מעודכנים לרגע הפתיחה.</p>
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              variant="secondary"
              size="sm"
              title="ליצור קישור חדש?"
              description="הקישור הקודם יפסיק לעבוד מיד. מי שקיבל אותו לא יוכל לפתוח את דף החשבון."
              confirmLabel="יצירת קישור חדש"
              action={create}
            >
              קישור חדש
            </ConfirmButton>
            <ConfirmButton
              size="sm"
              title="לבטל את הקישור?"
              description="הלקוח לא יוכל לפתוח את דף החשבון מהקישור הזה."
              confirmLabel="ביטול הקישור"
              action={revokeStatementLinkAction.bind(null, orgId, customer)}
              onDone={() => router.refresh()}
            >
              ביטול הקישור
            </ConfirmButton>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">קישור שהלקוח פותח בלי להירשם, ורואה בו את החובות הפתוחים: כל מסמך, היתרה שלו והאיחור. אפשר להדפיס או לשמור כ-PDF מהדף.</p>
          <Button size="sm" variant="secondary" onClick={() => void createFirst()} loading={busy}>
            יצירת קישור לדף חשבון
          </Button>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}
