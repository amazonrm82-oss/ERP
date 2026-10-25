import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-picker";
import { buttonClasses } from "@/components/ui/button";
import { getOrgContext } from "@/features/shell/queries";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

import { LEDGER_PARTIAL_TEXT, ledgerPeriod, ledgerView, lineMuted, lineNote, lineTitle } from "../ledger";
import { getLedger, ledgerInPlan } from "../queries";

type Props = {
  orgId: string;
  // the contact's ledger holds its company's contacts and deals too (PAY-02's customer); the company's holds them all
  where: { contact: string | null; company: string | null };
  // the period from the page's address (lf, lt); empty = the last 12 months
  from?: string | null;
  to?: string | null;
  // the page's own address, kept when the period changes
  keep?: Record<string, string | undefined>;
};

const day = (iso: string) => formatDate(`${iso}T12:00:00Z`);
const amount = (agorot: number) => (agorot === 0 ? "" : formatMoney(agorot));

/**
 * BAL-01: the customer's ledger ("כספים"): documents as debits, payments as credits, a running balance, the period's opening
 * and closing balance, and today's open debt and credit. Every line is one the user reads (RLS). Shown with the `balances`,
 * `documents` and `payments` keys, to owners, admins, managers and holders of `record_payments` (owner's answer 3 ב). When
 * some of the customer's rows are hidden from the user, only their lines show, with "חלק מהשורות מוסתרות" and no balance.
 * A management view, not bookkeeping: the screen says so.
 */
export async function LedgerCard({ orgId, where, from, to, keep = {} }: Props) {
  if (!(await ledgerInPlan(orgId))) return null;
  const context = await getOrgContext(orgId);
  const period = ledgerPeriod(zoneDate(new Date(), context.org.timeZone), from, to);
  const ledger = await getLedger(orgId, where, period);
  const view = ledgerView(ledger);
  if (view === "hidden" || !ledger.allowed) return null;
  const full = ledger.partial ? null : ledger;
  const titleId = `ledger-${where.contact ?? where.company}`;
  return (
    <Card aria-labelledby={titleId} id="ledger">
      <CardHeader id={titleId} title="כספים" />
      <CardBody className="space-y-4">
        {full ? (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-ink-soft">יתרת חוב פתוחה</dt>
              <dd className="text-md font-semibold tabular-nums">{formatMoney(full.open_debt)}</dd>
            </div>
            <div>
              <dt className="text-ink-soft">יתרת זכות</dt>
              <dd className="text-md font-semibold tabular-nums">{formatMoney(full.credit_balance)}</dd>
            </div>
            <div>
              <dt className="text-ink-soft">יתרה בסוף התקופה</dt>
              <dd className="text-md font-semibold tabular-nums">{formatMoney(full.closing)}</dd>
            </div>
            <div>
              <dt className="text-ink-soft">יתרת פתיחה</dt>
              <dd className="text-md tabular-nums">{formatMoney(full.opening)}</dd>
            </div>
          </dl>
        ) : (
          <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink" role="note">
            {LEDGER_PARTIAL_TEXT}
          </p>
        )}

        <form method="get" action="#ledger" className="flex flex-wrap items-end gap-2 print:hidden">
          {Object.entries(keep).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
          <DateField label="מתאריך" name="lf" defaultValue={period.from} />
          <DateField label="עד תאריך" name="lt" defaultValue={period.to} />
          <button type="submit" className={buttonClasses("secondary", "md")}>
            הצגה
          </button>
        </form>

        {ledger.truncated ? (
          <p className="text-sm text-ink-soft">
            {full ? "מוצגות 500 השורות האחרונות בתקופה. היתרה לפניהן מופיעה בשורה הראשונה." : "מוצגות 500 השורות האחרונות בתקופה."}
          </p>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-line" role="region" aria-label="שורות הכרטסת" tabIndex={0}>
          <table className="w-full min-w-max border-collapse text-sm">
            <caption className="sr-only">
              כרטסת הלקוח מ-{day(period.from)} עד {day(period.to)}
            </caption>
            <thead>
              <tr className="border-b border-line text-ink-soft">
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  תאריך
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  פירוט
                </th>
                <th scope="col" className="px-3 py-2 text-end font-medium">
                  חובה
                </th>
                <th scope="col" className="px-3 py-2 text-end font-medium">
                  זכות
                </th>
                {full ? (
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    יתרה
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {full ? (
                <tr>
                  <td className="px-3 py-2 whitespace-nowrap">{day(period.from)}</td>
                  <td className="px-3 py-2 text-ink-soft">{full.truncated ? "יתרה לפני השורות המוצגות" : "יתרת פתיחה"}</td>
                  <td />
                  <td />
                  <td className="px-3 py-2 text-end tabular-nums">{formatMoney(full.shown_opening)}</td>
                </tr>
              ) : null}
              {ledger.lines.map((line) => {
                const note = lineNote(line);
                const muted = lineMuted(line);
                return (
                  <tr key={`${line.kind}-${line.id}`} className={cn(muted && "text-ink-soft")}>
                    <td className="px-3 py-2 whitespace-nowrap">{day(line.date)}</td>
                    <td className="px-3 py-2">
                      <span className="block">{lineTitle(line)}</span>
                      {note ? (
                        <span className="block text-ink-soft">
                          {note}
                          {muted && line.amount ? ` · ${formatMoney(line.amount)}` : ""}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">{amount(line.debit)}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{amount(line.credit)}</td>
                    {"balance" in line ? <td className="px-3 py-2 text-end tabular-nums">{formatMoney(line.balance)}</td> : null}
                  </tr>
                );
              })}
            </tbody>
            {full ? (
              <tfoot>
                <tr className="border-t border-line font-medium">
                  <td className="px-3 py-2" colSpan={2}>
                    סך התקופה
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">{formatMoney(full.debit)}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{formatMoney(full.credit)}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{formatMoney(full.closing)}</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
        {ledger.lines.length === 0 ? <p className="text-sm text-ink-soft">אין מסמכים או תשלומים בתקופה הזו.</p> : null}
        <p className="text-sm text-ink-soft">
          הכרטסת היא תצוגת ניהול ולא הנהלת חשבונות. המקור המחייב הוא תוכנת החשבוניות ורואה החשבון של העסק. חובה: חשבוניות ומסמכים שהלקוח צריך לשלם. זכות:
          תשלומים שהתקבלו וזיכויים.
        </p>
      </CardBody>
    </Card>
  );
}
