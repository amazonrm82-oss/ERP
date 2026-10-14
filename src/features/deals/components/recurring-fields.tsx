"use client";

import { useState } from "react";

import { SelectField, TextField } from "@/components/ui/field";

import { BILLING_KIND_LABELS, BILLING_KINDS, billingKindOf, suggestRenewalDate, type BillingKind } from "../recurring";

export type RecurringInitial = { kind: string | null; amount: string; start: string; renewal: string };

type Props = {
  initial: RecurringInitial;
  // the values sent with a failed submit win over the stored ones
  submitted?: Record<string, string>;
  errors: Record<string, string>;
  // DLI-03: the stored recurring amount follows the product lines
  amountAuto?: boolean;
};

/**
 * DEAL-07: deal type (one-time, monthly, yearly), and for a recurring deal the amount,
 * the start date and the renewal date. The renewal date follows the start (one month or
 * one year on) until the person types a date of their own.
 */
export function RecurringFields({ initial, submitted, errors, amountAuto = false }: Props) {
  const startKind = billingKindOf(submitted?.billing_kind ?? initial.kind);
  const startStart = submitted?.recurring_start_date ?? initial.start;
  const startRenewal = submitted?.renewal_date ?? initial.renewal;
  const [kind, setKind] = useState<BillingKind>(startKind);
  const [start, setStart] = useState(startStart);
  const [renewal, setRenewal] = useState(startRenewal);
  // a stored date that is not the suggestion was chosen by a person: keep it
  const [ownRenewal, setOwnRenewal] = useState(startRenewal !== "" && startRenewal !== (suggestRenewalDate(startStart, startKind) ?? ""));

  function follow(nextStart: string, nextKind: BillingKind) {
    if (!ownRenewal) setRenewal(suggestRenewalDate(nextStart, nextKind) ?? "");
  }

  const recurring = kind !== "one_time";
  return (
    <fieldset className="space-y-4">
      <legend className="sr-only">הכנסה חוזרת</legend>
      <SelectField
        label="סוג עסקה"
        name="billing_kind"
        value={kind}
        onChange={(event) => {
          const next = billingKindOf(event.target.value);
          setKind(next);
          follow(start, next);
        }}
        error={errors.billing_kind}
      >
        {BILLING_KINDS.map((value) => (
          <option key={value} value={value}>
            {BILLING_KIND_LABELS[value]}
          </option>
        ))}
      </SelectField>
      {recurring ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label={kind === "monthly" ? "סכום חודשי (₪)" : "סכום שנתי (₪)"}
            name="recurring_amount"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            defaultValue={submitted?.recurring_amount ?? initial.amount}
            error={errors.recurring_amount}
            hint={
              amountAuto
                ? "מחושב לפי שורות המוצר, לפני מע\"מ. סכום שתקלידו יישאר קבוע; שדה ריק יחזיר את החישוב."
                : "שדה ריק יחושב לפי שורות המוצר בעסקה."
            }
          />
          <TextField
            label="תאריך התחלה"
            name="recurring_start_date"
            type="date"
            required
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
              follow(event.target.value, kind);
            }}
            error={errors.recurring_start_date}
          />
          <TextField
            label="תאריך חידוש"
            name="renewal_date"
            type="date"
            value={renewal}
            min={start || undefined}
            onChange={(event) => {
              setRenewal(event.target.value);
              setOwnRenewal(event.target.value !== "");
            }}
            error={errors.renewal_date}
            hint={kind === "monthly" ? "מוצע: חודש אחרי ההתחלה. אפשר לשנות." : "מוצע: שנה אחרי ההתחלה. אפשר לשנות."}
          />
        </div>
      ) : null}
    </fieldset>
  );
}
