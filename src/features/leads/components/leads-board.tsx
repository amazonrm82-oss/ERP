"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";
import { cn } from "@/lib/cn";
import type { LeadStatusKind } from "@/lib/database.types";
import { formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import { dropLeadAction } from "../actions";
import type { LeadBoard, LeadBoardCard } from "../queries";
import { LeadStatusMenu } from "./lead-status-menu";

const columnRule: Record<LeadStatusKind, string> = {
  open: "border-t-accent",
  converted: "border-t-success",
  disqualified: "border-t-line-strong",
};

const DRAG_TYPE = "application/x-lead-id";

// reasons: the organization's active "not relevant" reasons (LEAD-03); empty: typed in freely
type Props = { orgId: string; board: LeadBoard; canWrite: boolean; reasons: string[] };

/**
 * Leads by status, one column per status a lead can be moved to by hand.
 * Cards are dragged with a mouse; the status menu on every card does the same
 * with a keyboard or a touch screen. A drop on "not relevant" asks for the reason.
 */
export function LeadsBoard({ orgId, board, canWrite, reasons }: Props) {
  const [cards, moveOptimistic] = useOptimistic(board.cards, (current: LeadBoardCard[], move: { leadId: string; statusId: string }) =>
    current.map((card) => (card.id === move.leadId ? { ...card, statusId: move.statusId } : card)),
  );
  const [, startTransition] = useTransition();
  const [overStatus, setOverStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // a drop on "not relevant" waits here for its reason
  const [asking, setAsking] = useState<{ card: LeadBoardCard; statusId: string } | null>(null);
  const [reason, setReason] = useState("");

  const nameOf = (card: LeadBoardCard) => card.fullName || card.companyName || "ליד ללא שם";

  function move(card: LeadBoardCard, statusId: string, why: string | null) {
    const status = board.statuses.find((s) => s.id === statusId);
    if (!status) return;
    setError(null);
    startTransition(async () => {
      moveOptimistic({ leadId: card.id, statusId });
      const result = await dropLeadAction(orgId, card.id, statusId, why);
      if (result.ok) {
        setAnnouncement(`הליד ${nameOf(card)} הועבר לסטטוס ${status.name}.`);
      } else {
        // the optimistic move is dropped when the transition ends
        setError(result.message);
      }
    });
  }

  function onDrop(event: DragEvent, statusId: string) {
    event.preventDefault();
    setOverStatus(null);
    const card = cards.find((item) => item.id === event.dataTransfer.getData(DRAG_TYPE));
    const status = board.statuses.find((item) => item.id === statusId);
    if (!card || !status || card.statusId === statusId) return;
    if (status.kind === "disqualified") {
      setReason("");
      setAsking({ card, statusId });
      return;
    }
    move(card, statusId, null);
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
      {asking ? (
        <form
          aria-label="סיבה לליד לא רלוונטי"
          className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason.trim()) return;
            move(asking.card, asking.statusId, reason);
            setAsking(null);
          }}
        >
          <DisqualifyReasonField
            reasons={reasons}
            label={`למה הליד ${nameOf(asking.card)} לא רלוונטי?`}
            value={reason}
            onChange={setReason}
            autoFocus
            className="min-w-56 flex-1"
          />
          <Button type="submit" disabled={!reason.trim()}>
            העברה
          </Button>
          <Button variant="ghost" onClick={() => setAsking(null)}>
            ביטול
          </Button>
        </form>
      ) : null}
      {/* scrolls sideways on its own, so the page never does; `relative` keeps hidden labels inside */}
      <div role="region" aria-label="לוח לידים לפי סטטוס" tabIndex={0} className="relative -mx-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6">
        <ol className="flex min-w-max items-start gap-3">
          {board.statuses.map((status) => {
            const here = cards.filter((card) => card.statusId === status.id);
            // exact count from the database, adjusted by cards moved here or away on this screen
            const loadedHere = board.cards.filter((card) => card.statusId === status.id).length;
            const count = (board.counts[status.id] ?? 0) - loadedHere + here.length;
            const hidden = count - here.length;
            const headingId = `status-${status.id}`;
            return (
              <li key={status.id} className="w-[17.5rem] shrink-0">
                <section
                  aria-labelledby={headingId}
                  onDragOver={
                    canWrite
                      ? (event) => {
                          if (event.dataTransfer.types.includes(DRAG_TYPE)) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setOverStatus(status.id);
                          }
                        }
                      : undefined
                  }
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setOverStatus((current) => (current === status.id ? null : current));
                    }
                  }}
                  onDrop={canWrite ? (event) => onDrop(event, status.id) : undefined}
                >
                  <header className={cn("rounded-t-lg border border-t-[3px] border-line bg-surface px-3.5 py-2.5", columnRule[status.kind])}>
                    <h2 id={headingId} className="flex items-baseline justify-between gap-2 font-semibold">
                      <span className="truncate">{status.name}</span>
                      <span className="text-sm font-normal text-ink-soft">
                        {formatNumber(count)}
                        <span className="sr-only"> לידים</span>
                      </span>
                    </h2>
                  </header>
                  <div
                    className={cn(
                      "min-h-24 rounded-b-lg border border-t-0 border-line bg-canvas p-2 transition-colors",
                      overStatus === status.id && "bg-accent-soft outline-2 outline-accent outline-dashed -outline-offset-4",
                    )}
                  >
                    {here.length === 0 ? (
                      <p className="px-2 py-4 text-center text-sm text-ink-soft">אין לידים בסטטוס הזה</p>
                    ) : (
                      <ul className="space-y-2">
                        {here.map((card) => (
                          <li
                            key={card.id}
                            draggable={canWrite}
                            onDragStart={(event) => {
                              event.dataTransfer.setData(DRAG_TYPE, card.id);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            className={cn("rounded-md border border-line bg-surface p-3", canWrite && "cursor-grab active:cursor-grabbing")}
                          >
                            <Link
                              href={paths.lead(orgId, card.id)}
                              draggable={false}
                              className="block break-words font-medium leading-snug underline-offset-4 hover:underline"
                            >
                              {nameOf(card)}
                            </Link>
                            {card.companyName && card.fullName ? <p className="mt-0.5 break-words text-sm text-ink-soft">{card.companyName}</p> : null}
                            {card.phone ? (
                              <p className="mt-0.5 text-sm text-ink-soft" dir="ltr">
                                {card.phone}
                              </p>
                            ) : null}
                            {card.ownerName ? <p className="mt-0.5 text-sm text-ink-soft">{card.ownerName}</p> : null}
                            {canWrite ? (
                              <LeadStatusMenu
                                key={card.statusId}
                                orgId={orgId}
                                leadId={card.id}
                                leadName={nameOf(card)}
                                currentStatusId={card.statusId}
                                statuses={board.statuses}
                                reasons={reasons}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {hidden > 0 ? (
                      <p className="px-2 pt-2 text-center text-sm text-ink-soft">
                        {`מוצגים ${formatNumber(here.length)} מתוך ${formatNumber(count)}, החדשים ביותר. לשאר: תצוגת טבלה או חיפוש.`}
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
