"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { LONG_PRESS_MS, pressDistance, pressOutcome } from "@/features/calendar/long-press";

import type { LossReasonOption } from "@/features/deal-loss-reasons/queries";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import { RequiredFieldsDialog, type RequiredAsk } from "@/features/custom-fields/components/required-fields-dialog";

import { dropDealAction, moveDealWithFieldsAction } from "../actions";
import { edgeStep, moveTexts, stepStage } from "../board-drag";
import type { Board, BoardDeal } from "../queries";
import { STAGE_RULE, stageTone } from "../stage-colors";
import type { StuckInfo } from "../stuck-text";
import { entersWon, type CloseWindowSetup } from "../close-window";
import { DealLossDialog, type LossTarget } from "./deal-loss-dialog";
import { DealWonDialog, type WonTarget } from "./deal-won-dialog";
import { DealStageForm } from "./deal-stage-form";
import { DealCardFields, type CardLookups } from "./deal-card-fields";

const DRAG_TYPE = "application/x-deal-id";

// the column of a stage, scrolled into view while the keyboard picks a stage
const columnId = (stageId: string) => `stage-column-${stageId}`;

// links built by the page: "showClosed", and one per stage id that opens that stage in full
// stuck: open deal id -> stuck (time in stage) or no next step, and why (DEAL-01, DEAL-02)
// lossReasons: the active loss reasons, asked for after a deal is dropped on a lost stage (DEAL-03)
// closeWindow: what the close window needs when a deal moves into a won stage (DEAL-04); null for a viewer
type Props = {
  orgId: string;
  board: Board;
  canWrite: boolean;
  hrefs: Record<string, string>;
  stuck: Record<string, StuckInfo>;
  lossReasons: LossReasonOption[];
  closeWindow: CloseWindowSetup | null;
  // DEAL-09: the fields each card shows, in order, and the names they need
  cardFields: string[];
  lookups: CardLookups;
};

// a finger on a card (DEAL-10): waits for the long press, then drags; x/y where the finger is now
type TouchDrag = { dealId: string; startX: number; startY: number; startedAt: number; x: number; y: number; active: boolean; target: string | null };

/**
 * Kanban board: one column per stage, in pipeline order (first stage on the start side).
 * A card moves between columns in four ways that all end in the same move (DEAL-10):
 * dragged with a mouse; dragged with a finger after a long press (a swipe still scrolls,
 * and the board scrolls by itself near its edges); with the keyboard from the card's
 * "הזזה" button (Space or Enter lifts, arrows pick the stage, Enter drops, Escape cancels,
 * each step announced); and with the stage menu on every card.
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
  // FLD-09: a move the new stage would leave with empty required fields: asked for, saved with the move
  const [ask, setAsk] = useState<RequiredAsk | null>(null);
  // the keyboard move (DEAL-10): the lifted deal and the stage it would be dropped on
  const [lifted, setLifted] = useState<{ dealId: string; stageId: string } | null>(null);
  // the finger move (DEAL-10); the ref is the truth for the window listeners, the state draws it
  const [touch, setTouch] = useState<TouchDrag | null>(null);
  const touchRef = useRef<TouchDrag | null>(null);
  const pressTimer = useRef<number | null>(null);
  // the click that ends a finger drag must not open the deal
  const suppressClick = useRef(false);
  // after a keyboard move the card is drawn in another column: its "הזזה" button gets focus back
  const focusAfter = useRef<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const instructionsId = useId();

  /** The one move every way of moving ends in: the close window for a won stage, else the action. */
  function requestMove(deal: BoardDeal, stageId: string) {
    const stage = board.stages.find((item) => item.id === stageId);
    if (!stage || deal.stageId === stageId) {
      return;
    }
    setError(null);
    const fromKind = board.stages.find((item) => item.id === deal.stageId)?.kind;
    if (closeWindow && entersWon(fromKind, stage.kind)) {
      setWonFor({ dealId: deal.id, dealName: deal.name, stageId: stage.id, stageName: stage.name, amountAgorot: deal.amountAgorot, ownerId: deal.ownerId });
      return;
    }
    const dealId = deal.id;
    startTransition(async () => {
      moveOptimistic({ dealId, stageId });
      const result = await dropDealAction(orgId, dealId, stageId);
      const afterMove = () => {
        setAnnouncement(moveTexts.moved(deal.name, stage.name));
        if (stage.kind === "lost") {
          setLossFor({ dealId: deal.id, dealName: deal.name, competitor: deal.competitor, lossReason: deal.lossReason });
        }
      };
      if (result.ok) {
        afterMove();
      } else if ("missing" in result) {
        // the card goes back until the window is saved; cancel leaves it there
        setAsk({
          description: `העסקה ${deal.name} עוברת לשלב ${stage.name}`,
          fields: result.missing,
          save: (formData) => moveDealWithFieldsAction(orgId, dealId, stageId, null, formData),
          onSaved: afterMove,
        });
      } else {
        // the optimistic move is dropped when the transition ends
        setError(result.message);
      }
    });
  }

  function onDrop(event: DragEvent, stageId: string) {
    event.preventDefault();
    setOverStage(null);
    const deal = deals.find((item) => item.id === event.dataTransfer.getData(DRAG_TYPE));
    if (deal) {
      requestMove(deal, stageId);
    }
  }

  // --- keyboard (DEAL-10) ---------------------------------------------------

  function stageName(stageId: string): string {
    return board.stages.find((stage) => stage.id === stageId)?.name ?? "";
  }

  function cancelLift(announce: boolean) {
    if (lifted && announce) {
      const deal = deals.find((item) => item.id === lifted.dealId);
      if (deal) setAnnouncement(moveTexts.cancelled(deal.name));
    }
    setLifted(null);
    setOverStage(null);
  }

  /** Drops the lifted card on a stage: chosen with the keyboard, or a click on a column. */
  function dropLifted(stageId: string) {
    const deal = lifted ? deals.find((item) => item.id === lifted.dealId) : undefined;
    setLifted(null);
    setOverStage(null);
    if (!deal) return;
    if (stageId === deal.stageId) {
      setAnnouncement(moveTexts.unchanged(deal.name, stageName(stageId)));
      return;
    }
    focusAfter.current = deal.id;
    requestMove(deal, stageId);
  }

  // a card lifted with "הזזה": a click on a column drops it there, a click between columns cancels;
  // links, buttons and menus inside the board keep doing their own thing
  function onBoardClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!lifted) return;
    const target = event.target as HTMLElement;
    if (target.closest("a, button, select, input, textarea, label")) return;
    const stageId = target.closest<HTMLElement>("[data-stage-drop]")?.dataset.stageDrop;
    if (stageId) {
      dropLifted(stageId);
    } else {
      cancelLift(true);
    }
  }

  // Escape anywhere cancels a lift (focus may have gone to the board itself after a click)
  useEffect(() => {
    if (!lifted) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelLift(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function onHandleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, deal: BoardDeal) {
    const key = event.key;
    if (!lifted || lifted.dealId !== deal.id) {
      if (key === " " || key === "Enter") {
        event.preventDefault();
        setError(null);
        setLifted({ dealId: deal.id, stageId: deal.stageId });
        setOverStage(deal.stageId);
        setAnnouncement(moveTexts.lifted(deal.name, stageName(deal.stageId)));
      }
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelLift(true);
      return;
    }
    if (key === " " || key === "Enter") {
      event.preventDefault();
      dropLifted(lifted.stageId);
      return;
    }
    if (key === "Tab") {
      cancelLift(true);
      return;
    }
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const next = stepStage(board.stages, lifted.stageId, key, rtl);
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) {
      event.preventDefault();
    }
    if (!next) {
      return;
    }
    setLifted({ dealId: deal.id, stageId: next });
    setOverStage(next);
    const index = board.stages.findIndex((stage) => stage.id === next);
    setAnnouncement(moveTexts.over(board.stages[index].name, index + 1, board.stages.length, next === deal.stageId));
    document.getElementById(columnId(next))?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // the moved card is a new element in its new column: give its button the focus back,
  // unless the user has already gone somewhere else
  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    const handle = document.querySelector<HTMLElement>(`[data-move-handle="${id}"]`);
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && active !== handle) {
      focusAfter.current = null;
      return;
    }
    handle?.focus();
  }, [deals]);

  // --- a finger (DEAL-10) ---------------------------------------------------

  const touching = touch !== null;
  useEffect(() => {
    if (!touching) return;
    let frame: number | null = null;

    function targetAt(x: number, y: number): string | null {
      return document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-stage-drop]")?.dataset.stageDrop ?? null;
    }
    function update(next: TouchDrag | null) {
      touchRef.current = next;
      setTouch(next);
      setOverStage(next?.active ? next.target : null);
    }
    function clearPress() {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    function finish(drop: boolean) {
      const current = touchRef.current;
      clearPress();
      update(null);
      if (!current?.active) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 400);
      const deal = deals.find((item) => item.id === current.dealId);
      if (!deal) return;
      if (!drop || !current.target || current.target === deal.stageId) {
        setAnnouncement(moveTexts.cancelled(deal.name));
        return;
      }
      requestMove(deal, current.target);
    }
    // near an edge the board (sideways) and the page (up and down) scroll by themselves
    function tick() {
      frame = null;
      const current = touchRef.current;
      if (!current?.active) return;
      const scroller = scrollerRef.current;
      let moved = false;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const dx = edgeStep(current.x, rect.left, rect.right);
        if (dx !== 0) {
          scroller.scrollBy({ left: dx });
          moved = true;
        }
      }
      const dy = edgeStep(current.y, 0, window.innerHeight);
      if (dy !== 0) {
        window.scrollBy({ top: dy });
        moved = true;
      }
      if (moved) {
        const target = targetAt(current.x, current.y);
        if (target !== current.target) update({ ...current, target });
      }
      frame = requestAnimationFrame(tick);
    }

    function onPointerMove(event: PointerEvent) {
      const current = touchRef.current;
      if (!current || event.pointerType !== "touch") return;
      if (!current.active) {
        // a finger that moves before the long press is scrolling: let it
        const distance = pressDistance({ x: current.startX, y: current.startY }, { x: event.clientX, y: event.clientY });
        if (pressOutcome(distance, event.timeStamp - current.startedAt) === "cancel") finish(false);
        return;
      }
      update({ ...current, x: event.clientX, y: event.clientY, target: targetAt(event.clientX, event.clientY) });
      if (frame === null) frame = requestAnimationFrame(tick);
    }
    const onPointerUp = () => finish(true);
    const onCancel = () => finish(false);
    // once lifted, the finger drags the card instead of scrolling the page
    const onTouchMove = (event: TouchEvent) => {
      if (touchRef.current?.active && event.cancelable) event.preventDefault();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onCancel);
      if (frame !== null) cancelAnimationFrame(frame);
      clearPress();
    };
    // requestMove and deals are read when the finger lifts; the listeners live for one touch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touching]);

  function onCardPointerDown(event: ReactPointerEvent<HTMLLIElement>, deal: BoardDeal) {
    if (event.pointerType !== "touch" || !event.isPrimary || touchRef.current) return;
    // the stage menu and its buttons keep working as usual
    if ((event.target as HTMLElement).closest("select, button, input, textarea")) return;
    const pending: TouchDrag = {
      dealId: deal.id,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
      active: false,
      target: null,
    };
    touchRef.current = pending;
    setTouch(pending);
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      const current = touchRef.current;
      if (current !== pending) return;
      const next = { ...current, active: true, target: deal.stageId };
      touchRef.current = next;
      setTouch(next);
      setOverStage(deal.stageId);
      setError(null);
      setLifted(null);
      setAnnouncement(moveTexts.touchLifted(deal.name));
      if (typeof navigator.vibrate === "function") navigator.vibrate(15);
    }, LONG_PRESS_MS);
  }

  const touchDeal = touch?.active ? deals.find((deal) => deal.id === touch.dealId) : undefined;

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
      {canWrite ? (
        <p id={instructionsId} className="sr-only">
          {moveTexts.instructions}
        </p>
      ) : null}
      {touch?.active && touchDeal ? (
        // follows the finger (physical coordinates), above everything, never in the way of the target
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 max-w-60 -translate-x-1/2 -translate-y-[130%] truncate rounded-md border border-accent bg-surface px-3 py-2 text-sm font-medium text-ink shadow-lg"
          style={{ left: touch.x, top: touch.y }}
        >
          {touchDeal.name}
        </div>
      ) : null}
      <DealLossDialog
        orgId={orgId}
        target={lossFor}
        reasons={lossReasons}
        onClose={() => {
          const dealId = lossFor?.dealId;
          setLossFor(null);
          // the window gives focus back to what opened it; a card moved by keyboard is a new element by now
          if (dealId) {
            requestAnimationFrame(() => {
              const active = document.activeElement;
              if (!active || active === document.body) document.querySelector<HTMLElement>(`[data-move-handle="${dealId}"]`)?.focus();
            });
          }
        }}
      />
      <RequiredFieldsDialog ask={ask} onClose={() => setAsk(null)} />
      {wonFor && closeWindow ? (
        <DealWonDialog
          orgId={orgId}
          target={wonFor}
          setup={closeWindow}
          onClose={() => setWonFor(null)}
          onDone={(target) => {
            setAnnouncement(`העסקה ${target.dealName} נסגרה בהצלחה ועברה לשלב ${target.stageName}.`);
            // a keyboard move: the card's button gets the focus back in its new column
            focusAfter.current = target.dealId;
          }}
        />
      ) : null}
      {/* Scrolls sideways on its own, so the page never does. Focusable for keyboard scrolling.
          `relative` matters: without it the visually-hidden (absolutely positioned)
          labels inside off-screen columns escape the scroller and widen the page. */}
      <div
        ref={scrollerRef}
        onClick={canWrite ? onBoardClick : undefined}
        role="region"
        aria-label={`לוח עסקאות: ${board.pipeline.name}`}
        tabIndex={0}
        className={cn(
          "relative -mx-4 scroll-px-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:scroll-px-6 sm:px-6 md:snap-none",
          // snapping would fight the board's own scrolling while a finger drags a card
          touch?.active ? "snap-none" : "snap-x",
        )}
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
              <li key={stage.id} id={columnId(stage.id)} className={cn("w-[17.5rem] shrink-0 snap-start", lifted && "cursor-pointer")}>
                <section
                  aria-labelledby={headingId}
                  data-stage-drop={stage.id}
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
                              // a finger has its own drag (below); the browser's must not start as well
                              if (touchRef.current) {
                                event.preventDefault();
                                return;
                              }
                              event.dataTransfer.setData(DRAG_TYPE, deal.id);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            onPointerDown={canWrite ? (event) => onCardPointerDown(event, deal) : undefined}
                            // a long press must not open the phone's own menu
                            onContextMenu={(event) => {
                              if (touchRef.current?.dealId === deal.id) event.preventDefault();
                            }}
                            onClickCapture={(event) => {
                              if (suppressClick.current) {
                                event.preventDefault();
                                event.stopPropagation();
                              }
                            }}
                            className={cn(
                              "rounded-md border border-line bg-surface p-3",
                              canWrite && "cursor-grab select-none [-webkit-touch-callout:none] active:cursor-grabbing",
                              (lifted?.dealId === deal.id || (touch?.active && touch.dealId === deal.id)) && "opacity-70 ring-2 ring-accent",
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <Link
                                href={paths.deal(orgId, deal.id)}
                                draggable={false}
                                className="min-w-0 break-words font-medium leading-snug underline-offset-4 hover:underline"
                              >
                                {deal.name}
                              </Link>
                              {canWrite ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  data-move-handle={deal.id}
                                  aria-label={`הזזת העסקה ${deal.name}`}
                                  aria-describedby={instructionsId}
                                  aria-pressed={lifted?.dealId === deal.id}
                                  onKeyDown={(event) => onHandleKeyDown(event, deal)}
                                  onClick={(event) => {
                                    // a click that is a key press (Enter, Space) was handled on keydown;
                                    // a mouse or a tap lifts the card too, or cancels a lift
                                    if (event.detail === 0) return;
                                    if (lifted?.dealId === deal.id) {
                                      cancelLift(true);
                                    } else {
                                      setError(null);
                                      setLifted({ dealId: deal.id, stageId: deal.stageId });
                                      setOverStage(deal.stageId);
                                      setAnnouncement(moveTexts.lifted(deal.name, stageName(deal.stageId)));
                                    }
                                  }}
                                  onBlur={(event) => {
                                    // focus going to the board itself is a click on it: onBoardClick drops or cancels
                                    const next = event.relatedTarget as Node | null;
                                    if (next && scrollerRef.current?.contains(next)) return;
                                    if (lifted?.dealId === deal.id) cancelLift(true);
                                  }}
                                  className="-me-1 -mt-1 shrink-0"
                                >
                                  הזזה
                                </Button>
                              ) : null}
                            </div>
                            {lifted?.dealId === deal.id ? (
                              <p className="mt-2 rounded-sm bg-accent-soft px-2 py-1 text-sm text-accent-strong">{moveTexts.visibleHint}</p>
                            ) : null}
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
