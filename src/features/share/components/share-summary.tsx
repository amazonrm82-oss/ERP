"use client";

import { useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { ChatIcon } from "@/components/ui/icons";

/** Copy a record's summary, or open WhatsApp with it, to send to someone outside the system (GAP-04). */
export function ShareSummary({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        העתקת סיכום ל-WhatsApp
      </Button>
      <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer" className={buttonClasses("ghost", "sm")}>
        <ChatIcon className="size-4.5 text-accent" />
        שליחת הסיכום ב-WhatsApp
        <span className="sr-only">(נפתח בחלון חדש)</span>
      </a>
      <span role="status" className="text-sm text-ink-soft">
        {copied ? "הסיכום הועתק. מדביקים אותו בשיחה." : ""}
      </span>
    </div>
  );
}
