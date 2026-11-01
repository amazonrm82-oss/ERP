"use client";

import { useState, useTransition } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";

import { storeOrderPdfAction } from "../actions";

type Props = {
  orgId: string;
  orderId: string;
  // the stored PDF's download address (/o/[org]/files/[file]); null = none kept yet
  href: string | null;
  // may keep it now: a numbered order that is not cancelled, whose deal, contact or company the user may edit (the database decides again)
  canStore: boolean;
  // owner's answer (34) ב: the delivery date, shipping address or notes changed after the current PDF was made (its new
  // version failed when the order was saved); the user may make it now
  outdated?: boolean;
};

/**
 * ORD-05 PDF (owner, 1 November 2026, answer (1) ב): the PDF of a numbered order, as it was kept when the order got its
 * number. An order numbered before the PDF existed, or whose PDF could not be kept then (a full monthly quota), offers to
 * keep it now.
 */
export function OrderPdfButton({ orgId, orderId, href, canStore, outdated = false }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const keep = (label: string) => (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() => {
        setError(null);
        startTransition(async () => {
          const result = await storeOrderPdfAction(orgId, orderId);
          if (!result.ok) setError(result.message);
        });
      }}
    >
      {label}
    </Button>
  );
  if (href) {
    return (
      <span className="inline-flex flex-col gap-1">
        <span className="inline-flex flex-wrap gap-2">
          {/* a plain link: the route checks the file against its SHA-256 and sends it */}
          <a href={href} className={buttonClasses("secondary", "sm")}>
            הורדת PDF
          </a>
          {outdated && canStore ? keep("עדכון ה-PDF") : null}
        </span>
        <FormError message={error} />
      </span>
    );
  }
  if (!canStore) return null;
  return (
    <span className="inline-flex flex-col gap-1">
      {keep("שמירת PDF")}
      <FormError message={error} />
    </span>
  );
}
