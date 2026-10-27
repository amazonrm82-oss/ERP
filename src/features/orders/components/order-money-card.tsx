import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { ScheduleStep } from "@/features/quotes/schedule";
import { formatMoney } from "@/lib/format";

import {
  BILLING_STATE_LABELS,
  moneyRemainders,
  moneyStateTone,
  partialNote,
  PAYMENT_STATE_LABELS,
  STEP_STATE_LABELS,
  stepState,
  type OrderMoney,
} from "../money";

type Props = {
  money: OrderMoney;
  // the schedule's names, in order (the money's steps carry ids and amounts only)
  schedule: ScheduleStep[];
  // each half shows with its plan key (documents / payments)
  billing: boolean;
  payments: boolean;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * ORD-02 / ORD-04: how much of a numbered order is billed and paid, overall and per schedule step. Counted: the order's own
 * tax invoices and invoice-receipts less credit invoices, and its recorded or confirmed payments (database rule).
 */
export function OrderMoneyCard({ money, schedule, billing, payments }: Props) {
  const left = moneyRemainders(money);
  const names = new Map(schedule.map((step) => [step.id, step.name]));
  const halves = { billing, payments };
  const note = partialNote(money, halves);
  // a half is shown when its plan key is on and the user sees all of its rows
  const showBilling = billing && !money.billingPartial;
  const showPayments = payments && !money.paymentPartial;
  return (
    <Card aria-labelledby="order-money">
      <CardHeader id="order-money" title="חיוב ותשלום" />
      <CardBody className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          {billing && money.billingState ? <Badge tone={moneyStateTone(money.billingState)}>{BILLING_STATE_LABELS[money.billingState]}</Badge> : null}
          {payments && money.paymentState ? <Badge tone={moneyStateTone(money.paymentState)}>{PAYMENT_STATE_LABELS[money.paymentState]}</Badge> : null}
        </div>
        {note ? <p className="text-ink-soft">{note}</p> : null}
        {showBilling || showPayments ? (
          <>
            <dl className="space-y-1">
              <Row label="סכום ההזמנה" value={formatMoney(money.totalAgorot)} />
              {showBilling ? (
                <>
                  <Row label="חויב" value={formatMoney(money.billedAgorot ?? 0)} />
                  <Row label="נשאר לחייב" value={formatMoney(left.toBill ?? 0)} />
                  {left.overBilled > 0 ? <Row label="חויב מעבר לסכום" value={formatMoney(left.overBilled)} /> : null}
                  {money.requestedAgorot ? <Row label="דרישות תשלום (חשבון עסקה)" value={formatMoney(money.requestedAgorot)} /> : null}
                </>
              ) : null}
              {showPayments ? (
                <>
                  <Row label="שולם" value={formatMoney(money.paidAgorot ?? 0)} />
                  <Row label="נשאר לתשלום" value={formatMoney(left.toPay ?? 0)} />
                  {left.overPaid > 0 ? <Row label="שולם מעבר לסכום" value={formatMoney(left.overPaid)} /> : null}
                </>
              ) : null}
            </dl>
            <p className="text-ink-soft">
              {showPayments ? "תשלום שעוד לא הוקצה לחשבונית עשוי להיחשב יחד עם חשבונית-קבלה כאותו כסף; הקצאה שלו לחשבונית תציג את הסכום המלא. " : null}
              {showBilling && showPayments
                ? "נספרים מסמכים שנרשמו על ההזמנה, תשלומים שנרשמו עליה או כמקדמה לה, תשלומים וזיכויי פתיחה שהוקצו לחשבוניות שלה, וחשבונית-קבלה שלה (בלי לספור אותו כסף פעמיים). חשבונית זיכוי מורידה מהחיוב; מסמך או תשלום שבוטל לא נספר."
                : showBilling
                  ? "נספרים רק מסמכים שנרשמו על ההזמנה הזו. חשבונית זיכוי מורידה מהחיוב; מסמך שבוטל לא נספר."
                  : "נספרים תשלומים שנרשמו על ההזמנה או כמקדמה לה, ותשלומים שהוקצו לחשבוניות שלה. תשלום שבוטל, נכשל או הוחזר לא נספר."}
            </p>
          </>
        ) : null}
        {money.steps.length > 0 && (showBilling || showPayments) ? (
          <div>
            <h3 className="mb-2 text-md font-semibold">לפי לוח התשלומים</h3>
            <ul className="divide-y divide-line">
              {money.steps.map((step) => {
                const state = stepState(step, { billing: showBilling, payments: showPayments });
                return (
                  <li key={step.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0 break-words">
                      <bdi>{names.get(step.id) ?? "שלב"}</bdi>
                      <span className="text-ink-soft">
                        {" · "}
                        <span className="tabular-nums">{formatMoney(step.amountAgorot)}</span>
                        {showBilling ? (
                          <>
                            {" · חויב "}
                            <span className="tabular-nums">{formatMoney(step.billedAgorot ?? 0)}</span>
                          </>
                        ) : null}
                        {showPayments ? (
                          <>
                            {" · שולם "}
                            <span className="tabular-nums">{formatMoney(step.paidAgorot ?? 0)}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <Badge tone={state === "paid" ? "success" : state === "open" ? "neutral" : "warning"}>{STEP_STATE_LABELS[state]}</Badge>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-ink-soft">הסכומים ממלאים את השלבים לפי הסדר: קודם השלב הראשון, אחריו השני.</p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
