"use client";

import { useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";

import { quoteMailtoHref, quoteWhatsappHref } from "../share";

export type QuoteRecipient = {
  // the customer's name for the greeting (null = a plain "שלום")
  name: string | null;
  email: string | null;
  phoneE164: string | null;
};

type Props = {
  url: string;
  numberDisplay: string | null;
  businessName: string;
  recipient: QuoteRecipient;
};

/** QUO-08: copy the customer's link, or send it in WhatsApp or by email (the person's own app sends it). */
export function QuoteShareButtons({ url, numberDisplay, businessName, recipient }: Props) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("ההעתקה לא הצליחה. סמנו את הקישור והעתיקו ידנית.");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <a
          className={buttonClasses("secondary", "sm")}
          href={quoteWhatsappHref(url, numberDisplay, recipient.phoneE164)}
          target="_blank"
          rel="noopener noreferrer"
        >
          שליחה ב-WhatsApp
          <span className="sr-only"> (נפתח בחלון חדש)</span>
        </a>
        <a className={buttonClasses("secondary", "sm")} href={quoteMailtoHref(url, numberDisplay, businessName, recipient.name, recipient.email)}>
          שליחה באימייל
        </a>
        <Button size="sm" variant="secondary" onClick={() => void copy()}>
          {copied ? "הועתק" : "העתקת הקישור"}
        </Button>
      </div>
      <FormError message={error} />
    </div>
  );
}
