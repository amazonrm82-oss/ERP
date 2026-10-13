"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition, type DragEvent } from "react";

import type { LossReasonOption } from "@/features/deal-loss-reasons/queries";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import { dropDealAction } from "../actions";
import type { Board, BoardDeal } from "../queries";
import { STAGE_RULE, stageTone } from "../stage-colors";
import { entersWon, type CloseWindowSetup } from "../close-window";
import { DealLossDialog, type LossTarget } from "./deal-loss-dialog";
import { DealWonDialog, type WonTarget } from "./deal-won-dialog";
import { DealStageForm } from "./deal-stage-form";
import { DealCardFields, type CardLookups } from "./deal-card-fields";

const DRAG_TYPE = "application/x-deal-id";

// links built by the page: "showClosed", and one per stage id that opens that stage in full
// stuck: open deal id -> why it is stuck (DEAL-02)
// lossReasons: the active loss reasons, asked for after a deal is dropped on a lost stage (DEAL-03)
// closeWindow: what the close window needs when a deal moves into a won stage (DEAL-04); null for a viewer
type Props = {
  orgId: string;
  board: Board;
  canWrite: boolean;
  hrefs: Record<string, string>;
  stuck: Record<string, string>;
  lossReasons: LossReasonOption[];
  closeWindow: CloseWindowSetup | null;
  // DEAL-09: the fields each card shows, in order, and the names they need
  cardFields: string[];
  lookups: CardLookups;
};

/**
 * Kanban board: one column per stage, in pipeline order (first stage on the start side).
 * With a mouse, cards are dragged between columns; the stage menu on every card
 * does the same with a keyboard or a touch screen.
 */
export function DealsBoard({ orgId, board, canWrite, hrefs, stuck, lossReasons, closeWindow, cardFields, lookups }: Props) {
  const [deals, moveOptimistic] = useOptimistic(board.deals, (current: BoardDeal[], move: { dealId: string; stageId: string }) =>
    current.map((deal) => (deal.id === move.dealId ? { ...deal, stageId: move.stageId } : deal)),
  );
  const [, startTransition] = useTransition();
  const [overStage, setOverStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // a deal just dropped on a lost stage: why it was lost, and to whom (optional)
  const [lossFor, setLossFor] = useState<LossTarget | null>(null);
  // a deal dropped on a won stage: it moves only once the close window is confirmed (DEAL-04)
  const [wonFor, setWonFor] = useState<WonTarget | null>(null);

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
    const fromKind = board.stages.find((item) => item.id === deal.stageId)?.kind;
    if (closeWindow && entersWon(fromKind, stage.kind)) {
      setWonFor({ dealId: deal.id, dealName: deal.name, stageId: stage.id, stageName: stage.name, amountAgorot: deal.amountAgorot, ownerId: deal.ownerId });
      return;
    }
    startTransition(async () => {
      moveOptimistic({ dealId, stageId });
      const result = await dropDealAction(orgId, dealId, stageId);
      if (result.ok) {
        setAnnouncement(`העסקה ${deal.name} הועברה לשלב ${stage.name}.`);
        if (stage.kind === "lost") {
          setLossFor({ dealId: deal.id, dealName: deal.name, competitor: deal.competitor, lossReason: deal.lossReason });
        }
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
      <DealLossDialog orgId={orgId} target={lossFor} reasons={lossReasons} onClose={() => setLossFor(null)} />
      {wonFor && closeWindow ? (
        <DealWonDialog
          orgId={orgId}
          target={wonFor}
          setup={closeWindow}
          onClose={() => setWonFor(null)}
          onDone={(target) => setAnnouncement(`העסקה ${target.dealName} נסגרה בהצלחה ועברה לשלב ${target.stageName}.`)}
        />
      ) : null}
      {/* Scrolls sideways on its own, so the page never does. Focusable for keyboard scrolling.
          `relative` matters: without it the visually-hidden (absolutely positioned)
          labels inside off-screen columns escape the scroller and widen the page. */}
      <div
        role="region"
        aria-label={`לוח עסקאות: ${board.pipeline.name}`}
        tabIndex={0}
        className="relative -mx-4 snap-x scroll-px-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:scroll-px-6 sm:px-6 md:snap-none"
      >
        <ol className="flex min-w-max items-start gap-3">
          {board.stages.map((stage) => {
            const stageDeals = deals.filter((deal) => deal.stageId === stage.id);
            // exact totals from the database, adjusted by cards moved here or away on this screen
            const loadedHere = board.deals.filter((deal) => deal.stageId === stage.id);
            const exact = board.totals[stage.id] ?? { count: 0, amountAgorot: 0 };
            const sum = (list: BoardDeal[]) => list.reduce((acc, deal) => acc + deal.amountAgorot, 0);
            const count = exact.count - loadedHere.length + stageDeals.length;
            const total = exact.amountAgorot - sum(loadedHere) + sum(stageDeals);
            const loaded = board.loadedStages.includes(stage.id);
            const hidden = count - stageDeals.length;
            const headingId = `stage-${stage.id}`;
            return (
              <li key={stage.id} className="w-[17.5rem] shrink-0 snap-start">
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
                  <header className={cn("rounded-t-lg border border-t-[3px] border-line bg-surface px-3.5 py-2.5", STAGE_RULE[stageTone(stage)])}>
                    <h2 id={headingId} className="flex items-baseline justify-between gap-2 font-semibold">
                      <span className="truncate">{stage.name}</span>
                      <span className="text-sm font-normal text-ink-soft">
                        {formatNumber(count)}
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
                    {!loaded && stageDeals.length === 0 ? (
                      <p className="px-2 py-4 text-center text-sm text-ink-soft">
                        {count === 0 ? (
                          "אין עסקאות בשלב הזה"
                        ) : (
                          <Link href={hrefs.showClosed} className="text-accent-strong underline underline-offset-4">
                            הצגת {formatNumber(count)} העסקאות
                          </Link>
                        )}
                      </p>
                    ) : stageDeals.length === 0 ? (
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
                            <DealCardFields orgId={orgId} deal={deal} keys={cardFields} stuck={stuck[deal.id]} lookups={lookups} />
                            {canWrite ? (
                              <DealStageForm
                                key={deal.stageId}
                                orgId={orgId}
                                dealId={deal.id}
                                dealName={deal.name}
                                currentStageId={deal.stageId}
                                stages={board.stages}
                                lossReasons={lossReasons}
                                competitor={deal.competitor}
                                lossReason={deal.lossReason}
                                closeWindow={closeWindow}
                                amountAgorot={deal.amountAgorot}
                                ownerId={deal.ownerId}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {loaded && hidden > 0 ? (
                      <p className="px-2 pt-2 text-center text-sm text-ink-soft">
                        {`מוצגות ${formatNumber(stageDeals.length)} מתוך ${formatNumber(count)}. `}
                        {hrefs[stage.id] ? (
                          <Link href={hrefs[stage.id]} className="text-accent-strong underline underline-offset-4">
                            הצגת כולן
                          </Link>
                        ) : null}
                      </p>
                    ) : null}
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
