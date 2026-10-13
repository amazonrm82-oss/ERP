"use client";

import { useActionState, useState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { LossFields } from "@/features/deal-loss-reasons/components/loss-fields";
import type { LossReasonOption } from "@/features/deal-loss-reasons/queries";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { moveDealAction } from "../actions";
import type { StageOption } from "../queries";

type Props = {
  orgId: string;
  dealId: string;
  dealName: string;
  currentStageId: string;
  stages: StageOption[];
  // DEAL-03: offered when the chosen stage is a lost one; empty or absent: no question
  lossReasons?: LossReasonOption[];
  competitor?: string | null;
  // the deal's reason today: the default, so a move between lost stages does not drop it
  lossReason?: LossReasonOption | null;
};

/**
 * Per-card stage menu: pick a stage, then confirm with the button that appears.
 * Works with keyboard and touch alike, and never moves a deal by accident while
 * browsing the options. The board remounts the card (key) after a move.
 * A lost stage also asks, without insisting, why and to whom (DEAL-03).
 */
export function DealStageForm({ orgId, dealId, dealName, currentStageId, stages, lossReasons, competitor, lossReason }: Props) {
  const [selected, setSelected] = useState(currentStageId);
  const [state, dispatch, pending] = useActionState<FormState, FormData>(moveDealAction.bind(null, orgId, dealId), null);
  const failure = state && !state.ok ? state : null;
  const changed = selected !== currentStageId;
  const askLoss = changed && lossReasons !== undefined && stages.find((stage) => stage.id === selected)?.kind === "lost";

  return (
    // submitted by hand: the select is controlled (see submitWith)
    <form onSubmit={submitWith(dispatch)} className="mt-3 space-y-2" noValidate>
      <div className="flex items-end gap-2">
        <SelectField
          label={`שלב של העסקה ${dealName}`}
          hideLabel
          name="stage_id"
          controlSize="sm"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="min-w-0 flex-1"
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </SelectField>
        {changed && !askLoss ? (
          <SubmitButton size="sm" pending={pending} pendingText="מעבירים…">
            העברה
          </SubmitButton>
        ) : null}
      </div>
      {askLoss ? (
        <div className="space-y-2 rounded-md border border-line bg-canvas p-2.5">
          <LossFields reasons={lossReasons} current={lossReason} competitor={competitor} errors={failure?.fieldErrors} controlSize="sm" />
          <SubmitButton size="sm" pending={pending} pendingText="מעבירים…">
            העברה
          </SubmitButton>
        </div>
      ) : null}
      <FormError message={failure?.message} />
    </form>
  );
}
