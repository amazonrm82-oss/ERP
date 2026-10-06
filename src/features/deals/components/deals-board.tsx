import Link from "next/link";

import { cn } from "@/lib/cn";
import type { StageKind } from "@/lib/database.types";
import { formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { Board } from "../queries";
import { DealStageForm } from "./deal-stage-form";

// The coloured rule on top of a column says what kind of stage it is.
const columnRule: Record<StageKind, string> = {
  open: "border-t-accent",
  won: "border-t-success",
  lost: "border-t-line-strong",
};

type Props = { orgId: string; board: Board; canWrite: boolean };

/** Kanban board: one column per stage, in pipeline order (first stage on the start side). */
export function DealsBoard({ orgId, board, canWrite }: Props) {
  return (
    // Scrolls sideways on its own, so the page never does. Focusable for keyboard scrolling.
    // `relative` matters: without it the visually-hidden (absolutely positioned)
    // labels inside off-screen columns escape the scroller and widen the page.
    <div
      role="region"
      aria-label={`לוח עסקאות: ${board.pipeline.name}`}
      tabIndex={0}
      className="relative -mx-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6"
    >
      <ol className="flex min-w-max items-start gap-3">
        {board.stages.map((stage) => {
          const deals = board.deals.filter((deal) => deal.stageId === stage.id);
          const total = deals.reduce((sum, deal) => sum + deal.amountAgorot, 0);
          const headingId = `stage-${stage.id}`;
          return (
            <li key={stage.id} className="w-[17.5rem] shrink-0">
              <section aria-labelledby={headingId}>
                <header className={cn("rounded-t-lg border border-t-[3px] border-line bg-surface px-3.5 py-2.5", columnRule[stage.kind])}>
                  <h2 id={headingId} className="flex items-baseline justify-between gap-2 font-semibold">
                    <span className="truncate">{stage.name}</span>
                    <span className="text-sm font-normal text-ink-soft">
                      {formatNumber(deals.length)}
                      <span className="sr-only"> עסקאות</span>
                    </span>
                  </h2>
                  <p className="text-sm text-ink-soft">
                    <span className="sr-only">סך הכול </span>
                    {formatMoney(total)}
                  </p>
                </header>

                <div className="rounded-b-lg border border-t-0 border-line bg-canvas p-2">
                  {deals.length === 0 ? (
                    <p className="px-2 py-4 text-center text-sm text-ink-soft">אין עסקאות בשלב הזה</p>
                  ) : (
                    <ul className="space-y-2">
                      {deals.map((deal) => (
                        <li key={deal.id} className="rounded-md border border-line bg-surface p-3">
                          <p className="break-words font-medium leading-snug">{deal.name}</p>
                          <p className="mt-0.5 text-[0.9375rem]">{formatMoney(deal.amountAgorot)}</p>
                          {deal.contactId && deal.contactName ? (
                            <p className="mt-0.5 text-sm">
                              <Link
                                href={paths.contact(orgId, deal.contactId)}
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
  );
}
