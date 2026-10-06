"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition, type DragEvent } from "react";

import { cn } from "@/lib/cn";
import type { StageKind } from "@/lib/database.types";
import { formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import { dropDealAction } from "../actions";
import type { Board, BoardDeal } from "../queries";
import { DealStageForm } from "./deal-stage-form";

// The coloured rule on top of a column says what kind of stage it is.
const columnRule: Record<StageKind, string> = {
  open: "border-t-accent",
  won: "border-t-success",
  lost: "border-t-line-strong",
};

const DRAG_TYPE = "application/x-deal-id";

type Props = { orgId: string; board: Board; canWrite: boolean };

/**
 * Kanban board: one column per stage, in pipeline order (first stage on the start side).
 * With a mouse, cards are dragged between columns; the stage menu on every card
 * does the same with a keyboard or a touch screen.
 */
export function DealsBoard({ orgId, board, canWrite }: Props) {
  const [deals, moveOptimistic] = useOptimistic(board.deals, (current: BoardDeal[], move: { dealId: string; stageId: string }) =>
    current.map((deal) => (deal.id === move.dealId ? { ...deal, stageId: move.stageId } : deal)),
  );
  const [, startTransition] = useTransition();
  const [overStage, setOverStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function onDrop(event: DragEvent, stageId: string) {
    event.preventDefault();
    setOverStage(null);
    const dealId = event.dataTransfer.getData(DRAG_TYPE);
    const deal = deals.find((item) => item.id === dealId);
    const stage = board.stages.find((item) => item.id === stageId);
    if (!deal || !stage || deal.stageId === stageId) {
      return;
    }
    setError(null);
    startTransition(async () => {
      moveOptimistic({ dealId, stageId });
      const result = await dropDealAction(orgId, dealId, stageId);
      if (result.ok) {
        setAnnouncement(`העסקה ${deal.name} הועברה לשלב ${stage.name}.`);
      } else {
        // the optimistic move is dropped when the transition ends
        setError(result.message);
      }
    });
  }

  return (
    <>
      {error ? (
        <p role="alert" className="mb-3 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {/* Scrolls sideways on its own, so the page never does. Focusable for keyboard scrolling.
          `relative` matters: without it the visually-hidden (absolutely positioned)
          labels inside off-screen columns escape the scroller and widen the page. */}
      <div
        role="region"
        aria-label={`לוח עסקאות: ${board.pipeline.name}`}
        tabIndex={0}
        className="relative -mx-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6"
      >
        <ol className="flex min-w-max items-start gap-3">
          {board.stages.map((stage) => {
            const stageDeals = deals.filter((deal) => deal.stageId === stage.id);
            const total = stageDeals.reduce((sum, deal) => sum + deal.amountAgorot, 0);
            const headingId = `stage-${stage.id}`;
            return (
              <li key={stage.id} className="w-[17.5rem] shrink-0">
                <section
                  aria-labelledby={headingId}
                  onDragOver={
                    canWrite
                      ? (event) => {
                          if (event.dataTransfer.types.includes(DRAG_TYPE)) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setOverStage(stage.id);
                          }
                        }
                      : undefined
                  }
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setOverStage((current) => (current === stage.id ? null : current));
                    }
                  }}
                  onDrop={canWrite ? (event) => onDrop(event, stage.id) : undefined}
                >
                  <header className={cn("rounded-t-lg border border-t-[3px] border-line bg-surface px-3.5 py-2.5", columnRule[stage.kind])}>
                    <h2 id={headingId} className="flex items-baseline justify-between gap-2 font-semibold">
                      <span className="truncate">{stage.name}</span>
                      <span className="text-sm font-normal text-ink-soft">
                        {formatNumber(stageDeals.length)}
                        <span className="sr-only"> עסקאות</span>
                      </span>
                    </h2>
                    <p className="text-sm text-ink-soft">
                      <span className="sr-only">סך הכול </span>
                      {formatMoney(total)}
                    </p>
                  </header>

                  <div
                    className={cn(
                      "min-h-24 rounded-b-lg border border-t-0 border-line bg-canvas p-2 transition-colors",
                      overStage === stage.id && "bg-accent-soft outline-2 outline-accent outline-dashed -outline-offset-4",
                    )}
                  >
                    {stageDeals.length === 0 ? (
                      <p className="px-2 py-4 text-center text-sm text-ink-soft">אין עסקאות בשלב הזה</p>
                    ) : (
                      <ul className="space-y-2">
                        {stageDeals.map((deal) => (
                          <li
                            key={deal.id}
                            draggable={canWrite}
                            onDragStart={(event) => {
                              event.dataTransfer.setData(DRAG_TYPE, deal.id);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            className={cn("rounded-md border border-line bg-surface p-3", canWrite && "cursor-grab active:cursor-grabbing")}
                          >
                            <Link
                              href={paths.deal(orgId, deal.id)}
                              draggable={false}
                              className="block break-words font-medium leading-snug underline-offset-4 hover:underline"
                            >
                              {deal.name}
                            </Link>
                            <p className="mt-0.5 text-[0.9375rem]">{formatMoney(deal.amountAgorot)}</p>
                            {deal.contactId && deal.contactName ? (
                              <p className="mt-0.5 text-sm">
                                <Link
                                  href={paths.contact(orgId, deal.contactId)}
                                  draggable={false}
                                  className="text-ink-soft underline-offset-4 hover:text-ink hover:underline"
                                >
                                  {deal.contactName}
                                </Link>
                              </p>
                            ) : null}
                            {canWrite ? (
                              <DealStageForm
                                key={deal.stageId}
                                orgId={orgId}
                                dealId={deal.id}
                                dealName={deal.name}
                                currentStageId={deal.stageId}
                                stages={board.stages}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}
