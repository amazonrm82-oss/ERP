"use client";

import { useState, useTransition } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";

import { storeSignedQuotePdfAction } from "../actions";
import { SIGNED_PDF_LABEL } from "../decision";

type Props = {
  orgId: string;
  quoteId: string;
  // the signed PDF's download address (/o/[org]/files/[file]); null = none kept yet
  href: string | null;
  // may make it now: an accepted quote whose deal or contact the user may edit (the database decides again)
  canStore: boolean;
};

/**
 * QUO-09 signed PDF (owner, 1 November 2026, answer (33) ב): the accepted quote's signed PDF, kept when the customer accepted.
 * When it could not be made then (a full monthly quota, an error), whoever may edit the quote makes it here.
 */
export function QuoteSignedPdfButton({ orgId, quoteId, href, canStore }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (href) {
    return (
      // a plain link: the route checks the file against its SHA-256 and sends it
      <a href={href} className={buttonClasses("secondary", "sm")}>
        {SIGNED_PDF_LABEL}
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
            const result = await storeSignedQuotePdfAction(orgId, quoteId);
            if (!result.ok) setError(result.message);
          });
        }}
      >
        יצירת PDF חתום
      </Button>
      <FormError message={error} />
    </span>
  );
}
