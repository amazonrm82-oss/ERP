"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { WEEKDAYS_LONG } from "@/lib/calendar-grid";

import { TOTAL_MAX, TOTAL_MIN, type RepeatValues } from "../recurrence";

export const REPEAT_OPTIONS = [
  { value: "none", label: "בלי חזרה" },
  { value: "daily", label: "כל יום" },
  { value: "weekly", label: "כל שבוע" },
  { value: "monthly", label: "כל חודש" },
  { value: "after_done", label: "כמה ימים אחרי שמסיימים" },
] as const;

const END_OPTIONS = [
  { value: "never", label: "בלי סוף" },
  { value: "until", label: "עד תאריך" },
  { value: "count", label: "אחרי מספר משימות" },
] as const;

function weekdayList(text: string | null | undefined): number[] {
  return (text ?? "")
    .split(",")
    .filter((d) => /^[0-6]$/.test(d))
    .map(Number);
}

type Props = { values: RepeatValues; errors: Record<string, string> };

/**
 * "חזרה" in the task form (TASK-04): none, every day, chosen weekdays, a day of
 * the month, or N days after completion; optionally until a date or a number of
 * times. Only the fields of the chosen kind are shown; the server ignores the rest.
 */
export function RecurrenceFields({ values, errors }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const weekdaysErrorId = useId();
  const [kind, setKind] = useState(values.repeat || "none");
  const [weekdays, setWeekdays] = useState<number[]>(() => weekdayList(values.repeat_weekdays));
  const [end, setEnd] = useState(values.repeat_end || "never");

  // the new-task form clears itself after a save; the choices go back with it
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const reset = () => {
      setKind(values.repeat || "none");
      setWeekdays(weekdayList(values.repeat_weekdays));
      setEnd(values.repeat_end || "never");
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [values.repeat, values.repeat_weekdays, values.repeat_end]);

  const toggleDay = (day: number, on: boolean) =>
    setWeekdays((current) => (on ? [...new Set([...current, day])].sort((a, b) => a - b) : current.filter((d) => d !== day)));

  return (
    <div ref={ref} className="space-y-4">
      <SelectField
        label="חזרה"
        name="repeat"
        value={kind}
        onChange={(event) => setKind(event.target.value)}
        hint={kind === "none" ? undefined : "כשמסמנים \"בוצע\", נוצרת המשימה הבאה."}
        error={errors.repeat}
      >
        {REPEAT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>

      {kind === "weekly" ? (
        <fieldset aria-describedby={errors.repeat_weekdays ? weekdaysErrorId : undefined}>
          <legend className="mb-1.5 text-sm font-medium text-ink">בימים</legend>
          <input type="hidden" name="repeat_weekdays" value={weekdays.join(",")} />
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            {WEEKDAYS_LONG.map((label, day) => (
              <Checkbox key={day} label={label} checked={weekdays.includes(day)} onChange={(event) => toggleDay(day, event.target.checked)} />
            ))}
          </div>
          {errors.repeat_weekdays ? (
            <p id={weekdaysErrorId} className="mt-1.5 text-sm text-danger">
              {errors.repeat_weekdays}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {kind === "monthly" ? (
        <TextField
          label="ביום בחודש"
          name="repeat_day"
          type="number"
          inputMode="numeric"
          min={1}
          max={31}
          dir="ltr"
          hint="בחודש קצר יותר: ביום האחרון שלו"
          defaultValue={values.repeat_day ?? ""}
          error={errors.repeat_day}
        />
      ) : null}

      {kind === "after_done" ? (
        <TextField
          label="כמה ימים אחרי שמסיימים"
          name="repeat_days"
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          dir="ltr"
          defaultValue={values.repeat_days ?? ""}
          error={errors.repeat_days}
        />
      ) : null}

      {kind === "none" ? null : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="סיום החזרה" name="repeat_end" value={end} onChange={(event) => setEnd(event.target.value)} error={errors.repeat_end}>
            {END_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
          {end === "until" ? (
            <TextField label="עד תאריך" name="repeat_until" type="date" defaultValue={values.repeat_until ?? ""} error={errors.repeat_until} />
          ) : null}
          {end === "count" ? (
            <TextField
              label="כמה משימות בסך הכול"
              name="repeat_count"
              type="number"
              inputMode="numeric"
              min={TOTAL_MIN}
              max={TOTAL_MAX}
              dir="ltr"
              hint="כולל המשימה הזו"
              defaultValue={values.repeat_count ?? ""}
              error={errors.repeat_count}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
