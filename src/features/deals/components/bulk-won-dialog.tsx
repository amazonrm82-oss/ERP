"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/field";
import { formatMoney } from "@/lib/format";

import { closeDateError } from "../close-window";
import { OldCloseDateQuestion, useOldCloseDate } from "./old-close-date";

export type BulkWonSetup = { today: string; timeZone: string };
export type BulkWonChoice = { closedDate: string; onboarding: boolean };

type Props = {
  open: boolean;
  count: number;
  totalAgorot: number;
  stageName: string;
  setup: BulkWonSetup;
  onConfirm: (close: BulkWonChoice) => void;
  onClose: () => void;
};

/**
 * DEAL-04, the bulk close window (owner's answer, 13 October 2026): how many
 * deals move into the won stage and their total, one close date for all.
 * Amounts are not asked. The onboarding tasks start unchecked here, whatever
 * the single window remembers.
 */
export function BulkWonDialog({ open, count, totalAgorot, stageName, setup, onConfirm, onClose }: Props) {
  return (
    <Dialog open={open} onClose={onClose} title="העסקאות נסגרו בהצלחה?" description={`העברה לשלב ${stageName}`} variant="sheet">
      {open ? <BulkWonForm count={count} totalAgorot={totalAgorot} setup={setup} onConfirm={onConfirm} onCancel={onClose} /> : null}
    </Dialog>
  );
}

type FormProps = { count: number; totalAgorot: number; setup: BulkWonSetup; onConfirm: (close: BulkWonChoice) => void; onCancel: () => void };

function BulkWonForm({ count, totalAgorot, setup, onConfirm, onCancel }: FormProps) {
  // a date more than three months back is confirmed first; its "yes" submits the form again
  const { check, asking, confirm, cancel } = useOldCloseDate(setup.today);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const closedDate = String(form.get("closed_date") ?? "");
    const invalid = closeDateError(closedDate, setup.today);
    setError(invalid);
    if (invalid || !check(closedDate)) return;
    onConfirm({ closedDate, onboarding: form.get("onboarding") === "on" });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="text-md text-ink">
        {count === 1 ? "עסקה אחת" : `${count} עסקאות`} בסך <span dir="ltr">{formatMoney(totalAgorot)}</span>. הסכומים לא משתנים.
      </p>
      <DateField
        label="תאריך סגירה לכולן"
        name="closed_date"
        required
        defaultValue={setup.today}
        max={setup.today}
        timeZone={setup.timeZone}
        error={error ?? undefined}
      />
      <Checkbox
        label="ליצור משימת קליטה לכל עסקה"
        hint="באחריות אחראי העסקה, עד יום העבודה הבא. עסקה שכבר יש לה משימת קליטה פתוחה לא תקבל עוד אחת."
        name="onboarding"
        defaultChecked={false}
      />
      <OldCloseDateQuestion day={asking} onConfirm={confirm} onCancel={cancel} />
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit">סגירה בהצלחה</Button>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
