"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { LossFields } from "@/features/deal-loss-reasons/components/loss-fields";
import { moveOpenDealAction, snoozeDealAction } from "@/features/deals/actions";
import { DealWonDialog, type WonTarget } from "@/features/deals/components/deal-won-dialog";
import { MAX_SNOOZE_DAYS } from "@/features/deals/snooze";
import { setExpectedCloseDateAction } from "@/features/reports/forecast-actions";
import type { FormState } from "@/lib/action-result";
import { addDays } from "@/lib/calendar-grid";
import { formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { CleanupActions } from "../queries";
import { advanceChoices, cleanupReasons, nextOpenStage, type CleanupDeal } from "../rules";

type Props = {
  orgId: string;
  deals: CleanupDeal[];
  total: number;
  actions: CleanupActions | null;
};

type Open = { kind: "advance" | "snooze" | "lost"; deal: CleanupDeal } | null;

/**
 * MNY-05: the deals that need a decision, each with three choices: advance (the next open stage,
 * or another one; a win opens the DEAL-04 close window), postpone with a date (DEAL-01), or close
 * as lost with a reason (DEAL-03). Everything is written with the user's session; rows the user
 * may not change show no choices. After a change the page refreshes and the deal leaves the list.
 */
export function CleanupList({ orgId, deals, total, actions }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const [won, setWon] = useState<WonTarget | null>(null);
  const editable = new Set(actions?.editable ?? []);
  const close = () => setOpen(null);
  const done = () => {
    setOpen(null);
    router.refresh();
  };
  const stagesOf = (deal: CleanupDeal) => actions?.stages[deal.pipelineId];

  return (
    <>
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {deals.map((deal) => {
          const canEdit = actions !== null && editable.has(deal.id);
          const stages = stagesOf(deal);
          return (
            <li key={deal.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <Link href={paths.deal(orgId, deal.id)} className="min-w-0 break-words font-medium underline-offset-4 hover:underline">
                  {deal.name || "עסקה ללא שם"}
                </Link>
                <span className="text-sm font-medium tabular-nums">{formatMoney(deal.amount)}</span>
              </div>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
                {deal.stuck ? <Badge tone="warning">תקועה</Badge> : null}
                {deal.overdue ? <Badge tone="danger">תאריך הסגירה עבר</Badge> : null}
                <span>
                  {deal.ownerName ? <bdi>{deal.ownerName}</bdi> : "בלי אחראי"}
                  {deal.stageName ? ` · ${deal.stageName}` : ""}
                </span>
              </p>
              <p className="mt-0.5 text-sm text-ink-soft">{cleanupReasons(deal, formatNumber).join(" · ")}</p>
              {canEdit && stages ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" aria-label={`לקדם: ${deal.name}`} onClick={() => setOpen({ kind: "advance", deal })}>
                    לקדם
                  </Button>
                  <Button size="sm" variant="secondary" aria-label={`לדחות עם תאריך: ${deal.name}`} onClick={() => setOpen({ kind: "snooze", deal })}>
                    לדחות
                  </Button>
                  {stages.lost ? (
                    <Button size="sm" variant="secondary" aria-label={`סגירה כאבודה עם סיבה: ${deal.name}`} onClick={() => setOpen({ kind: "lost", deal })}>
                      סגירה כאבודה
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {total > deals.length ? (
        <p className="mt-3 text-sm text-ink-soft">
          מוצגות {formatNumber(deals.length)} עסקאות מתוך {formatNumber(total)}. אחרי שתטפלו בהן יופיעו הבאות.
        </p>
      ) : null}

      {actions ? (
        <>
          <Dialog open={open?.kind === "advance"} onClose={close} title="לקדם את העסקה" description={open?.kind === "advance" ? open.deal.name : undefined} variant="sheet">
            {open?.kind === "advance" ? (
              <AdvanceForm
                key={open.deal.id}
                orgId={orgId}
                deal={open.deal}
                actions={actions}
                onCancel={close}
                onDone={done}
                onWon={(target) => {
                  setOpen(null);
                  setWon(target);
                }}
              />
            ) : null}
          </Dialog>
          <Dialog open={open?.kind === "snooze"} onClose={close} title="לדחות עד תאריך" description={open?.kind === "snooze" ? open.deal.name : undefined} variant="sheet">
            {open?.kind === "snooze" ? <SnoozeForm key={open.deal.id} orgId={orgId} deal={open.deal} today={actions.today} timeZone={actions.closeWindow.timeZone} onCancel={close} onDone={done} /> : null}
          </Dialog>
          <Dialog open={open?.kind === "lost"} onClose={close} title="סגירה כאבודה" description={open?.kind === "lost" ? open.deal.name : undefined} variant="sheet">
            {open?.kind === "lost" && stagesOf(open.deal)?.lost ? (
              <LostForm key={open.deal.id} orgId={orgId} deal={open.deal} stageId={stagesOf(open.deal)!.lost!.id} reasons={actions.lossReasons} onCancel={close} onDone={done} />
            ) : null}
          </Dialog>
          <DealWonDialog orgId={orgId} target={won} setup={actions.closeWindow} expectOpen onClose={() => setWon(null)} onDone={() => router.refresh()} />
        </>
      ) : null}
    </>
  );
}

function useDone(state: FormState, onDone: () => void) {
  useEffect(() => {
    if (state?.ok) onDone();
    // onDone changes every render; the result is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}

function FormButtons({ pending, label, pendingText, onCancel }: { pending: boolean; label: string; pendingText: string; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <SubmitButton pending={pending} pendingText={pendingText}>
        {label}
      </SubmitButton>
      <Button variant="secondary" onClick={onCancel}>
        ביטול
      </Button>
    </div>
  );
}

const WON = "won";
const DATE_SAVED_MOVE_FAILED = "תאריך הסגירה עודכן, אבל המעבר לשלב לא נשמר";

function AdvanceForm({
  orgId,
  deal,
  actions,
  onCancel,
  onDone,
  onWon,
}: {
  orgId: string;
  deal: CleanupDeal;
  actions: CleanupActions;
  onCancel: () => void;
  onDone: () => void;
  onWon: (target: WonTarget) => void;
}) {
  const stages = actions.stages[deal.pipelineId];
  const choices = advanceChoices(stages?.open ?? [], deal.stageId);
  const next = nextOpenStage(stages?.open ?? [], deal.stageId);
  const won = stages?.won ?? null;
  const [stageId, setStageId] = useState(next?.id ?? (won ? WON : (choices[0]?.id ?? "")));
  const [day, setDay] = useState(addDays(actions.today, 7));

  // An overdue deal also needs a new expected close date, or it stays on the list. No existing
  // action writes the date and the stage in one update, so the date is saved first (it is checked
  // there), then the deal moves; when only the date was saved, the message says so. Both with the
  // user's session.
  const [state, action, pending] = useActionState<FormState, FormData>(async (_prev, formData) => {
    if (!deal.overdue) {
      return moveOpenDealAction(orgId, deal.id, null, formData);
    }
    const dated = await setExpectedCloseDateAction(orgId, deal.id, null, formData);
    if (!dated?.ok) return dated;
    const moved = await moveOpenDealAction(orgId, deal.id, null, formData);
    if (moved && !moved.ok) {
      return { ok: false, message: `${DATE_SAVED_MOVE_FAILED} (${moved.message})` };
    }
    return moved;
  }, null);
  useDone(state, onDone);
  const failure = state && !state.ok ? state : null;

  if (stageId === WON && won) {
    // a win goes through the close window (amount, close date, onboarding task)
    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onWon({ dealId: deal.id, dealName: deal.name, stageId: won.id, stageName: won.name, amountAgorot: deal.amount, ownerId: deal.ownerId });
        }}
      >
        <StagePicker choices={choices} won={won} value={stageId} onChange={setStageId} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit">להמשך לסגירה כזכייה</Button>
          <Button variant="secondary" onClick={onCancel}>
            ביטול
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form action={action} className="space-y-4" noValidate>
      <StagePicker choices={choices} won={won} value={stageId} onChange={setStageId} />
      <input type="hidden" name="stage_id" value={stageId} />
      {deal.overdue ? (
        <DateField
          label="תאריך סגירה צפוי חדש"
          name="expected_close_date"
          value={day}
          onChange={setDay}
          min={actions.today}
          required
          timeZone={actions.closeWindow.timeZone}
          error={failure?.fieldErrors?.expected_close_date}
          hint="תאריך הסגירה של העסקה עבר. בלי תאריך חדש היא תישאר ברשימה."
        />
      ) : null}
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormButtons pending={pending} label="לקדם" pendingText="מעבירים…" onCancel={onCancel} />
    </form>
  );
}

function StagePicker({ choices, won, value, onChange }: { choices: { id: string; name: string }[]; won: { id: string; name: string } | null; value: string; onChange: (value: string) => void }) {
  return (
    <SelectField label="לאיזה שלב" value={value} onChange={(event) => onChange(event.target.value)} hint="ברירת המחדל היא השלב הבא בתהליך.">
      {choices.map((stage) => (
        <option key={stage.id} value={stage.id}>
          {stage.name}
        </option>
      ))}
      {won ? <option value={WON}>{`${won.name} (סגירה כזכייה)`}</option> : null}
    </SelectField>
  );
}

function SnoozeForm({ orgId, deal, today, timeZone, onCancel, onDone }: { orgId: string; deal: CleanupDeal; today: string; timeZone: string; onCancel: () => void; onDone: () => void }) {
  // DEAL-01: the same action and rules as the deal page (a day after today, up to a year ahead)
  const [state, action, pending] = useActionState<FormState, FormData>(snoozeDealAction.bind(null, orgId, deal.id), null);
  const [day, setDay] = useState(addDays(today, 7));
  useDone(state, onDone);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={action} className="space-y-4" noValidate>
      <DateField
        label="לדחות עד"
        name="snoozed_until"
        value={day}
        onChange={setDay}
        min={addDays(today, 1)}
        max={addDays(today, MAX_SNOOZE_DAYS)}
        required
        timeZone={timeZone}
        error={failure?.fieldErrors?.snoozed_until}
        hint="עד היום הזה העסקה לא תופיע בניקוי ולא תסומן כתקועה. מעבר לשלב אחר מבטל את הדחייה."
      />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormButtons pending={pending} label="לדחות" pendingText="שומרים…" onCancel={onCancel} />
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
  deal: CleanupDeal;
  stageId: string;
  reasons: CleanupActions["lossReasons"];
  onCancel: () => void;
  onDone: () => void;
}) {
  // DEAL-03: the same move and rules as the stage menu (reason optional, only an active one), for a deal still open
  const [state, action, pending] = useActionState<FormState, FormData>(moveOpenDealAction.bind(null, orgId, deal.id), null);
  useDone(state, onDone);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="stage_id" value={stageId} />
      <LossFields reasons={reasons} errors={failure?.fieldErrors} autoFocus />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormButtons pending={pending} label="סגירה כאבודה" pendingText="סוגרים…" onCancel={onCancel} />
    </form>
  );
}
