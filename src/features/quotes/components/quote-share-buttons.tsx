"use client";

import { useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";

import { quoteMailtoHref, quoteWhatsappHref, shareOrder } from "../share";

export type QuoteRecipient = {
  // the customer's name for the greeting (null = a plain "שלום")
  name: string | null;
  email: string | null;
  phoneE164: string | null;
  // CON-10: the contact's preferred channel; its button comes first
  preferredChannel?: string | null;
  // the person sending, named in the WhatsApp message (WA-01's {שם הנציג})
  senderName?: string | null;
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

  const buttons = {
    whatsapp: (
      <a
        key="whatsapp"
        className={buttonClasses("secondary", "sm")}
        href={quoteWhatsappHref(url, numberDisplay, recipient.phoneE164, {
          customerName: recipient.name,
          senderName: recipient.senderName,
          businessName,
        })}
        target="_blank"
        rel="noopener noreferrer"
      >
        שליחה ב-WhatsApp
        <span className="sr-only"> (נפתח בחלון חדש)</span>
      </a>
    ),
    email: (
      <a key="email" className={buttonClasses("secondary", "sm")} href={quoteMailtoHref(url, numberDisplay, businessName, recipient.name, recipient.email)}>
        שליחה באימייל
      </a>
    ),
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {shareOrder(recipient.preferredChannel).map((channel) => buttons[channel])}
        <Button size="sm" variant="secondary" onClick={() => void copy()}>
          {copied ? "הועתק" : "העתקת הקישור"}
        </Button>
      </div>
      <FormError message={error} />
    </div>
  );
}
