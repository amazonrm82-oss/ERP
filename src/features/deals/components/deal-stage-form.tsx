"use client";

import { useActionState, useState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { moveDealAction } from "../actions";
import type { StageOption } from "../queries";

type Props = { orgId: string; dealId: string; dealName: string; currentStageId: string; stages: StageOption[] };

/**
 * Per-card stage menu: pick a stage, then confirm with the button that appears.
 * Works with keyboard and touch alike, and never moves a deal by accident while
 * browsing the options. The board remounts the card (key) after a move.
 */
export function DealStageForm({ orgId, dealId, dealName, currentStageId, stages }: Props) {
  const [selected, setSelected] = useState(currentStageId);
  const [state, dispatch, pending] = useActionState<FormState, FormData>(moveDealAction.bind(null, orgId, dealId), null);
  const failure = state && !state.ok ? state : null;
  const changed = selected !== currentStageId;

  return (
    // submitted by hand: the select is controlled (see submitWith)
    <form onSubmit={submitWith(dispatch)} className="mt-3 space-y-2">
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
        {changed ? (
          <SubmitButton size="sm" pending={pending} pendingText="מעביר…">
            העברה
          </SubmitButton>
        ) : null}
      </div>
      <FormError message={failure?.message} />
    </form>
  );
}
