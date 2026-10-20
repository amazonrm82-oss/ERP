"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";

import { createOrderLinkAction, revokeOrderLinkAction } from "../link-actions";

type Props = {
  orgId: string;
  orderId: string;
  active: boolean;
  // already formatted for the screen
  createdText: string;
};

/**
 * ORD-05: the customer's link to a numbered order. The link is shown once, right after it is made (only its hash is kept):
 * copy it and send it then. After that a new link replaces it (the old one stops working), or it is turned off. The
 * customer sees the confirmation in the business's design, and a new order waits for their approval and signature.
 */
export function OrderLinkCard({ orgId, orderId, active, createdText }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setError(null);
    const result = await createOrderLinkAction(orgId, orderId);
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

  return (
    <Card aria-labelledby={`${inputId}-title`}>
      <CardHeader id={`${inputId}-title`} title="קישור ללקוח" />
      <CardBody className="space-y-3">
        {url ? (
          <div className="space-y-3">
            <Label htmlFor={inputId}>הקישור להזמנה</Label>
            <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
            <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. העתיקו ושלחו אותו ללקוח: מי שיש לו את הקישור רואה את ההזמנה.</p>
            <div>
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
            <p className="text-md">יש להזמנה קישור פעיל{createdText ? ` מאז ${createdText}` : ""}. הלקוח רואה בו את אישור ההזמנה ואת המצב שלה.</p>
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                variant="secondary"
                size="sm"
                title="ליצור קישור חדש?"
                description="הקישור הקודם יפסיק לעבוד מיד. מי שקיבל אותו לא יוכל לפתוח את ההזמנה."
                confirmLabel="יצירת קישור חדש"
                action={create}
              >
                קישור חדש
              </ConfirmButton>
              <ConfirmButton
                size="sm"
                title="לבטל את הקישור?"
                description="הלקוח לא יוכל לפתוח את ההזמנה מהקישור הזה."
                confirmLabel="ביטול הקישור"
                action={revokeOrderLinkAction.bind(null, orgId, orderId)}
                onDone={() => router.refresh()}
              >
                ביטול הקישור
              </ConfirmButton>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-md">קישור שהלקוח פותח בטלפון או במחשב, בלי להירשם, ורואה בו את אישור ההזמנה. בהזמנה חדשה הוא יכול לאשר ולחתום, או לדחות.</p>
            <Button size="sm" onClick={() => void createFirst()} loading={busy}>
              יצירת קישור ללקוח
            </Button>
          </div>
        )}
        <FormError message={error} />
      </CardBody>
    </Card>
  );
}
