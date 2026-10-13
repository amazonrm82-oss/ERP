"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { LossFields } from "@/features/deal-loss-reasons/components/loss-fields";
import type { LossReasonOption } from "@/features/deal-loss-reasons/queries";
import type { FormState } from "@/lib/action-result";

import { setDealLossAction } from "../actions";

// lossReason: the deal's reason today (kept by a move between lost stages), the default answer
export type LossTarget = { dealId: string; dealName: string; competitor: string | null; lossReason: LossReasonOption | null };

type Props = { orgId: string; target: LossTarget | null; reasons: LossReasonOption[]; onClose: () => void };

/**
 * DEAL-03: right after a deal is dragged to a lost stage, ask why and to whom.
 * The move already happened; both answers are optional and "דילוג" just closes.
 */
export function DealLossDialog({ orgId, target, reasons, onClose }: Props) {
  return (
    <Dialog open={target !== null} onClose={onClose} title="למה העסקה אבדה?" description={target?.dealName} variant="sheet">
      {target ? <LossForm key={target.dealId} orgId={orgId} target={target} reasons={reasons} onDone={onClose} /> : null}
    </Dialog>
  );
}

function LossForm({ orgId, target, reasons, onDone }: { orgId: string; target: LossTarget; reasons: LossReasonOption[]; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await setDealLossAction(orgId, target.dealId, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <LossFields reasons={reasons} current={target.lossReason} competitor={failure?.values?.competitor ?? target.competitor} errors={failure?.fieldErrors} autoFocus />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">שמירה</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          דילוג
        </Button>
      </div>
    </form>
  );
}
