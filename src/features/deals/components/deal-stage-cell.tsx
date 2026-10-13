"use client";

import { useState, type ReactNode } from "react";

import { InlineEdit, type InlineOption } from "@/features/inline-edit/components/inline-edit";

import { entersWon } from "../close-window";
import type { StageOption } from "../queries";
import { DealWonDialog, type CloseWindowSetup, type WonTarget } from "./deal-won-dialog";

type Props = {
  orgId: string;
  deal: { id: string; name: string; stageId: string; amountAgorot: number; ownerId: string | null };
  stages: StageOption[];
  // DEAL-03: the names of the active loss reasons, offered on a lost stage
  lossReasons: string[];
  // DEAL-04: null = no close window (the stage is saved in the cell, as before)
  closeWindow: CloseWindowSetup | null;
  canEdit: boolean;
  children: ReactNode;
};

/**
 * The stage cell of the deals table: edited in place, except that a move into a
 * won stage opens the close window (DEAL-04), which does the move itself.
 */
export function DealStageCell({ orgId, deal, stages, lossReasons, closeWindow, canEdit, children }: Props) {
  const [won, setWon] = useState<WonTarget | null>(null);
  const currentKind = stages.find((stage) => stage.id === deal.stageId)?.kind;
  const options: InlineOption[] = stages.map((stage) => ({
    value: stage.id,
    label: stage.name,
    // a lost stage offers a reason, when the organization has any (optional)
    needsReason: stage.kind === "lost" && lossReasons.length > 0,
    opensWindow: closeWindow !== null && entersWon(currentKind, stage.kind),
  }));

  return (
    <>
      <InlineEdit
        orgId={orgId}
        object="deal"
        id={deal.id}
        field="stage"
        kind="select"
        label={`שלב: ${deal.name}`}
        initial={{ id: deal.stageId }}
        options={options}
        reasons={lossReasons}
        canEdit={canEdit}
        onWindow={(stageId) => {
          const stage = stages.find((item) => item.id === stageId);
          if (stage) {
            setWon({ dealId: deal.id, dealName: deal.name, stageId: stage.id, stageName: stage.name, amountAgorot: deal.amountAgorot, ownerId: deal.ownerId });
          }
        }}
      >
        {children}
      </InlineEdit>
      {won && closeWindow ? <DealWonDialog orgId={orgId} target={won} setup={closeWindow} onClose={() => setWon(null)} /> : null}
    </>
  );
}
