"use client";

import { useState, useTransition } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";

import { storeQuotePdfAction } from "../actions";

type Props = {
  orgId: string;
  quoteId: string;
  // the stored PDF's download address (/o/[org]/files/[file]); null = none kept yet
  href: string | null;
  // may keep it now: a sent quote whose deal or contact the user may edit (the database decides again)
  canStore: boolean;
};

/**
 * QUO-06: the PDF of a sent quote, as it was kept when the quote was sent. A quote sent before the PDF existed, or whose
 * PDF could not be kept then (a full monthly quota), offers to keep it now.
 */
export function QuotePdfButton({ orgId, quoteId, href, canStore }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (href) {
    return (
      // a plain link: the route answers with a redirect to a one-minute signed address
      <a href={href} className={buttonClasses("secondary", "sm")}>
        הורדת PDF
      </a>
    );
  }
  if (!canStore) return null;
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant="secondary"
        size="sm"
        loading={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await storeQuotePdfAction(orgId, quoteId);
            if (!result.ok) setError(result.message);
          });
        }}
      >
        שמירת PDF
      </Button>
      <FormError message={error} />
    </span>
  );
}
