"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { DealWonDialog, type CloseWindowSetup, type WonTarget } from "@/features/deals/components/deal-won-dialog";

import { quoteDealMoveTargetAction } from "../accept-deal-actions";

// offer: the deal is still open and may be moved; setup: the close window's settings (null when not offered).
type Props = { orgId: string; quoteId: string; offer: boolean; setup: CloseWindowSetup | null };

/**
 * QUO-13, the "ask" flow (and the way back when the automatic step failed): the customer accepted, the deal is still
 * open. The button opens the won window (DEAL-04); confirming it replaces the deal's lines with the quote's and wins the
 * deal in one transaction. Cancelling changes nothing. Stays mounted after the refresh, to say when the lines were kept.
 */
export function QuoteDealMoveCard({ orgId, quoteId, offer, setup }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<WonTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!offer || !setup) {
    return done ? (
      <p role="status" className="mb-5 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
        {done}
      </p>
    ) : null;
  }

  const open = () => {
    setError(null);
    startTransition(async () => {
      const result = await quoteDealMoveTargetAction(orgId, quoteId);
      if (!result.ok) {
        setError(result.message);
        router.refresh();
        return;
      }
      if (result.data) setTarget(result.data);
    });
  };

  return (
    <section aria-labelledby="quote-deal-move-title" className="mb-5 rounded-lg border border-line bg-surface p-4 sm:p-5">
      <h2 id="quote-deal-move-title" className="text-base font-semibold">
        להעביר את העסקה לזכייה ולעדכן את השורות?
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        הלקוח אישר את ההצעה. בחלון הסגירה מאשרים את הסכום ואת תאריך הסגירה, ובשמירה השורות של העסקה מוחלפות בשורות שהלקוח אישר.
      </p>
      <FormError className="mt-3" message={error} />
      <div className="mt-3">
        <Button size="sm" onClick={open} loading={pending}>
          להעביר לזכייה ולעדכן את השורות
        </Button>
      </div>
      <DealWonDialog
        orgId={orgId}
        target={target}
        setup={setup}
        expectOpen
        quoteId={quoteId}
        onDone={(_target, message) => setDone(message ?? null)}
        onClose={() => {
          setTarget(null);
          router.refresh();
        }}
      />
    </section>
  );
}
