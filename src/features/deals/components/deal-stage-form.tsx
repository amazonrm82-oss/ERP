"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { LossFields } from "@/features/deal-loss-reasons/components/loss-fields";
import type { LossReasonOption } from "@/features/deal-loss-reasons/queries";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { moveDealAction } from "../actions";
import { entersWon, type CloseWindowSetup } from "../close-window";
import type { StageOption } from "../queries";
import { DealWonDialog, type WonTarget } from "./deal-won-dialog";

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
  // DEAL-04: a move into a won stage opens the close window; absent or null: a plain move
  closeWindow?: CloseWindowSetup | null;
  amountAgorot?: number;
  ownerId?: string | null;
};

/**
 * Per-card stage menu: pick a stage, then confirm with the button that appears.
 * Works with keyboard and touch alike, and never moves a deal by accident while
 * browsing the options. The board remounts the card (key) after a move.
 * A lost stage also asks, without insisting, why and to whom (DEAL-03); a won
 * stage opens the close window instead of moving (DEAL-04).
 */
export function DealStageForm({ orgId, dealId, dealName, currentStageId, stages, lossReasons, competitor, lossReason, closeWindow, amountAgorot = 0, ownerId = null }: Props) {
  const [selected, setSelected] = useState(currentStageId);
  const [state, dispatch, pending] = useActionState<FormState, FormData>(moveDealAction.bind(null, orgId, dealId), null);
  const failure = state && !state.ok ? state : null;
  const changed = selected !== currentStageId;
  const target = stages.find((stage) => stage.id === selected);
  const askLoss = changed && lossReasons !== undefined && target?.kind === "lost";
  const askWon = changed && Boolean(closeWindow) && entersWon(stages.find((stage) => stage.id === currentStageId)?.kind, target?.kind);
  const [won, setWon] = useState<WonTarget | null>(null);

  const openWon = () => {
    if (target) setWon({ dealId, dealName, stageId: target.id, stageName: target.name, amountAgorot, ownerId });
  };
  const submit = submitWith(dispatch);

  return (
    <>
      {/* submitted by hand: the select is controlled (see submitWith) */}
      <form
        onSubmit={(event) => {
          // a move into a won stage never goes straight through: the close window decides (DEAL-04)
          if (askWon) {
            event.preventDefault();
            openWon();
          } else {
            submit(event);
          }
        }}
        className="mt-3 space-y-2"
        noValidate
      >
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
          {askWon ? (
            <Button size="sm" onClick={openWon}>
              העברה
            </Button>
          ) : changed && !askLoss ? (
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
      {/* outside the form: forms do not nest */}
      {won && closeWindow ? (
        <DealWonDialog
          orgId={orgId}
          target={won}
          setup={closeWindow}
          onClose={() => {
            // cancelled (or done: the card remounts anyway): the menu shows the deal's stage again
            setWon(null);
            setSelected(currentStageId);
          }}
        />
      ) : null}
    </>
  );
}
