"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { TextLink } from "@/components/ui/text-link";
import type { TimelineSubject } from "@/features/activities/schema";
import { orderPath } from "@/features/orders/paths";

import { createMeetingOrderDraftAction } from "../actions";
import { meetingOrderDraftReasonText, type MeetingOrderDraftState } from "../rules";

type Props = {
  orgId: string;
  meetingId: string;
  subject: TimelineSubject | null;
  state: MeetingOrderDraftState;
};

/**
 * CAL-13: under a held meeting. A draft already made links to it; else the button "יצירת טיוטת הזמנה" while the rule
 * allows one, else the reason in one muted line. The database judges again when pressed.
 */
export function MeetingOrderDraft({ orgId, meetingId, subject, state }: Props) {
  const [pending, startTransition] = useTransition();
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const orderId = made ?? state.orderId;

  if (orderId) {
    return (
      <p className="text-sm">
        <TextLink href={orderPath(orgId, orderId)} className="font-medium">
          טיוטת ההזמנה מהפגישה
        </TextLink>
      </p>
    );
  }
  // a reason, or "exists" for an order on a record this person does not read
  if (state.reason) {
    return <p className="text-sm text-ink-soft">{meetingOrderDraftReasonText(state.reason)}</p>;
  }
  return (
    <div className="space-y-1.5">
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await createMeetingOrderDraftAction(orgId, meetingId, subject);
            if (result.ok && result.data) setMade(result.data.orderId);
            else if (!result.ok) setError(result.message);
          });
        }}
      >
        יצירת טיוטת הזמנה
      </Button>
      <FormError message={error} />
    </div>
  );
}
