"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { LossFields } from "@/features/deal-loss-reasons/components/loss-fields";
import { AskedFields } from "@/features/custom-fields/components/asked-fields";
import { askedFieldsFor } from "@/features/custom-fields/required-move";
import { moveOpenDealAction } from "@/features/deals/actions";
import { DealWonDialog, type WonTarget } from "@/features/deals/components/deal-won-dialog";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { OverdueDeal } from "../definitions";
import { setExpectedCloseDateAction } from "../forecast-actions";
import type { OverdueActionsSetup } from "../forecast-overdue-server";

type Props = {
  orgId: string;
  deals: OverdueDeal[];
  // the full count (the list holds the 200 oldest)
  total: number;
  setup: OverdueActionsSetup | null;
};

type Open = { kind: "date" | "lost"; deal: OverdueDeal } | null;

const dateText = (day: string) => formatDate(`${day}T12:00:00Z`);

/**
 * GOL-04 (owner, 13 October 2026): open deals whose expected close date has passed, each with a new
 * date, a win (the DEAL-04 close window) or a loss with a reason (DEAL-03), all with the user's
 * session. Rows the user may not change show no actions. After a change the page refreshes, so a
 * deal given a date in this month joins the month's forecast at once.
 */
export function ForecastOverdueDeals({ orgId, deals, total, setup }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const [won, setWon] = useState<WonTarget | null>(null);
  const editable = new Set(setup?.editable ?? []);
  const done = () => {
    setOpen(null);
    router.refresh();
  };

  return (
    <Card aria-labelledby="overdue-deals-title" id="overdue-deals" className="scroll-mt-20">
      <CardHeader id="overdue-deals-title" title="עסקאות שתאריך הסגירה שלהן עבר" />
      {deals.length === 0 ? (
        <p className="px-4 py-6 text-md text-ink-soft sm:px-5">אין עסקאות פתוחות שתאריך הסגירה שלהן עבר.</p>
      ) : (
        <ul className="divide-y divide-line">
          {deals.map((deal) => {
            const stages = setup?.stages[deal.pipelineId];
            const canEdit = setup !== null && editable.has(deal.id);
            return (
              <li key={deal.id} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <Link href={paths.deal(orgId, deal.id)} className="min-w-0 break-words font-medium underline-offset-4 hover:underline">
                    {deal.name}
                  </Link>
                  <span className="text-sm font-medium text-danger">תאריך הסגירה עבר: {dateText(deal.expected)}</span>
                </div>
                <p className="mt-0.5 text-sm text-ink-soft">
                  <bdi>{deal.ownerName}</bdi>
                  {deal.stageName ? ` · ${deal.stageName}` : ""} · <span className="tabular-nums">{formatMoney(deal.amount)}</span>, משוקלל{" "}
                  <span className="tabular-nums">{formatMoney(deal.weighted)}</span>
                </p>
                {canEdit ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" aria-label={`תאריך סגירה חדש: ${deal.name}`} onClick={() => setOpen({ kind: "date", deal })}>
                      תאריך סגירה חדש
                    </Button>
                    {stages?.won ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`סגירה כזכייה: ${deal.name}`}
                        onClick={() =>
                          setWon({
                            dealId: deal.id,
                            dealName: deal.name,
                            stageId: stages.won!.id,
                            stageName: stages.won!.name,
                            amountAgorot: deal.amount,
                            ownerId: deal.ownerId,
                          })
                        }
                      >
                        סגירה כזכייה
                      </Button>
                    ) : null}
                    {stages?.lost ? (
                      <Button size="sm" variant="secondary" aria-label={`סגירה כאבודה עם סיבה: ${deal.name}`} onClick={() => setOpen({ kind: "lost", deal })}>
                        סגירה כאבודה עם סיבה
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="border-t border-line px-4 py-2.5 text-sm text-ink-soft sm:px-5">
        {total > deals.length
          ? `מוצגות ${formatNumber(deals.length)} העסקאות הוותיקות מתוך ${formatNumber(total)}. `
          : ""}
        עסקאות אלה לא נכנסות לתחזית של אף חודש עד שיקבלו תאריך חדש.
      </p>

      {setup ? (
        <>
          <Dialog
            open={open?.kind === "date"}
            onClose={() => setOpen(null)}
            title="תאריך סגירה חדש"
            description={open?.kind === "date" ? open.deal.name : undefined}
            variant="sheet"
          >
            {open?.kind === "date" ? <DateForm key={open.deal.id} orgId={orgId} deal={open.deal} today={setup.today} timeZone={setup.closeWindow.timeZone} onCancel={() => setOpen(null)} onDone={done} /> : null}
          </Dialog>
          <Dialog
            open={open?.kind === "lost"}
            onClose={() => setOpen(null)}
            title="סגירה כאבודה"
            description={open?.kind === "lost" ? open.deal.name : undefined}
            variant="sheet"
          >
            {open?.kind === "lost" && setup.stages[open.deal.pipelineId]?.lost ? (
              <LostForm
                key={open.deal.id}
                orgId={orgId}
                deal={open.deal}
                stageId={setup.stages[open.deal.pipelineId]!.lost!.id}
                reasons={setup.lossReasons}
                onCancel={() => setOpen(null)}
                onDone={done}
              />
            ) : null}
          </Dialog>
          <DealWonDialog orgId={orgId} target={won} setup={setup.closeWindow} expectOpen onClose={() => setWon(null)} onDone={() => router.refresh()} />
        </>
      ) : null}
    </Card>
  );
}

function useDone(state: FormState, onDone: () => void) {
  useEffect(() => {
    if (state?.ok) onDone();
    // onDone changes every render; the result is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}

function DateForm({ orgId, deal, today, timeZone, onCancel, onDone }: { orgId: string; deal: OverdueDeal; today: string; timeZone: string; onCancel: () => void; onDone: () => void }) {
  const [state, action, pending] = useActionState<FormState, FormData>(setExpectedCloseDateAction.bind(null, orgId, deal.id), null);
  const [day, setDay] = useState(today);
  useDone(state, onDone);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={action} className="space-y-4" noValidate>
      <DateField
        label="תאריך סגירה צפוי"
        name="expected_close_date"
        value={day}
        onChange={setDay}
        min={today}
        required
        timeZone={timeZone}
        error={failure?.fieldErrors?.expected_close_date}
        hint={`היה ${dateText(deal.expected)}. תאריך בחודש הזה מכניס את העסקה לתחזית של החודש.`}
      />
      <FormError message={failure?.message} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending} pendingText="שומרים…">
          שמירה
        </SubmitButton>
        <Button variant="secondary" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

function LostForm({
  orgId,
  deal,
  stageId,
  reasons,
  onCancel,
  onDone,
}: {
  orgId: string;
  deal: OverdueDeal;
  stageId: string;
  reasons: OverdueActionsSetup["lossReasons"];
  onCancel: () => void;
  onDone: () => void;
}) {
  // DEAL-03: the same move and rules as the stage menu (reason optional, only an active one), for a deal still open
  const [state, action, pending] = useActionState<FormState, FormData>(moveOpenDealAction.bind(null, orgId, deal.id), null);
  useDone(state, onDone);
  const failure = state && !state.ok ? state : null;
  return (
    // submitted by hand: a form action resets the form, and the loss fields would lose the
    // chosen reason and competitor when the stage asks for fields first (FLD-09)
    <form onSubmit={submitWith(action)} className="space-y-4" noValidate>
      <input type="hidden" name="stage_id" value={stageId} />
      <LossFields reasons={reasons} errors={failure?.fieldErrors} autoFocus />
      <AskedFields object="deal" fields={askedFieldsFor(state, "stage_id", stageId)} submitted={failure?.values} errors={failure?.fieldErrors} />
      <FormError message={failure?.message} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending} pendingText="סוגרים…">
          סגירה כאבודה
        </SubmitButton>
        <Button variant="secondary" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
