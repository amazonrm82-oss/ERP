"use client";

import { useId, useMemo, useState } from "react";

import { Checkbox } from "@/components/ui/field";
import { formatMoney } from "@/lib/format";

import { choiceKeys, choiceTotals, initialChoice, isOptionalItem } from "../optional-choice";
import type { QuoteLine } from "../queries";
import { QuoteDecisionPanel } from "./quote-decision-panel";

type Props = {
  token: string;
  fingerprint: string;
  quote: { vatRateBp: number | null; pricesIncludeVat: boolean; discountBp: number | null; discountAgorot: number | null; };
  lines: QuoteLine[];
};

/**
 * QUO-08 (owner, 1 November 2026): the customer's answer to an open quote. When the quote has optional lines, the customer
 * ticks the ones they want first (all start unticked, owner's answer) and sees the total of that choice; the acceptance
 * carries the choice and that total, and the server refuses it if the two disagree.
 */
export function QuoteAnswerArea({ token, fingerprint, quote, lines }: Props) {
  const ids = useId();
  const optional = useMemo(() => lines.filter(isOptionalItem), [lines]);
  const [ticked, setTicked] = useState<string[]>(() => initialChoice(lines));
  const totals = useMemo(() => choiceTotals(quote, lines, ticked), [quote, lines, ticked]);

  if (optional.length === 0) return <QuoteDecisionPanel token={token} fingerprint={fingerprint} />;

  const choice = totals.ok ? { optionalKeys: choiceKeys(lines, ticked), acceptedTotalAgorot: totals.totals.totalAgorot } : null;
  return (
    <div className="space-y-4 print:hidden">
      <section aria-labelledby={`${ids}-options`} className="space-y-3 rounded-lg border border-line bg-surface p-4 sm:p-6">
        <h2 id={`${ids}-options`} className="text-lg font-semibold text-ink">
          שורות רשות
        </h2>
        <p className="text-sm text-ink-soft">סמנו את מה שתרצו להוסיף להצעה. הסכום מתעדכן לפי הבחירה.</p>
        {/* the starting total is the quote without its optional lines: told apart from the sent total and the PDF */}
        <p className="text-sm text-ink-soft">הסכום כולל רק את מה שסימנתם.</p>
        <ul className="space-y-2">
          {optional.map((line) => (
            <li key={line.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <Checkbox
                label={line.name}
                checked={ticked.includes(line.id)}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  setTicked((current) => (on ? [...current.filter((id) => id !== line.id), line.id] : current.filter((id) => id !== line.id)));
                }}
              />
              <span className="tabular-nums text-sm text-ink">{formatMoney(line.totalAgorot)}</span>
            </li>
          ))}
        </ul>
        <p role="status" aria-live="polite" className="flex flex-wrap justify-between gap-2 border-t border-line pt-3 text-md font-semibold text-ink">
          <span>סה״כ לתשלום לפי הבחירה שלכם</span>
          <span className="tabular-nums">{totals.ok ? formatMoney(totals.totals.totalAgorot) : "—"}</span>
        </p>
        {totals.ok ? null : <p className="text-sm text-danger">ההנחה על ההצעה גדולה מהשורות שנבחרו. סמנו שורות נוספות או פנו לעסק.</p>}
      </section>
      <QuoteDecisionPanel token={token} fingerprint={fingerprint} choice={choice} />
    </div>
  );
}
