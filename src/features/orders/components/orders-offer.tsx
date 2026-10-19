"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { answerOrdersOfferAction } from "@/features/modules/actions";

/**
 * ORD-01 (owner, 19 October 2026): when a quote is accepted, owners and admins are offered once to switch the orders module
 * on. Either answer closes the offer for the whole business; the switch stays in the business settings.
 */
export function OrdersOffer({ orgId }: { orgId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const answer = (switchOn: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await answerOrdersOfferAction(orgId, switchOn);
      if (!result.ok) setError(result.message);
    });
  };
  return (
    <Card aria-labelledby="orders-offer" className="print:hidden">
      <CardHeader id="orders-offer" title="לנהל גם הזמנות?" />
      <CardBody className="space-y-3">
        <p className="text-sm text-ink-soft">
          מודול ההזמנות הופך הצעה שאושרה להזמנה ממוספרת, עם מועד אספקה, כתובת משלוח ומצב (חדשה, בטיפול, סופקה). הוא כבוי עכשיו, ואפשר להפעיל ולכבות
          אותו בכל זמן ב&quot;הגדרות &gt; מודולים&quot;. כיבוי לא מוחק הזמנות.
        </p>
        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={() => answer(true)}>
            הפעלת ההזמנות
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => answer(false)}>
            לא עכשיו
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
