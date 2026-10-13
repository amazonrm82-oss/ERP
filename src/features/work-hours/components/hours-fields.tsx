"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { CloseIcon, PlusIcon } from "@/components/ui/icons";
import {
  MAX_DAY_RANGES,
  nextRange,
  rangeFieldNames,
  WEEKDAYS,
  type TimeRange,
  type Weekday,
  type WorkingHours,
} from "@/features/profile/working-hours";

// a range on screen; the id keeps React's keys stable when one is removed
type RangeRow = TimeRange & { id: number };

type Props = {
  legend: string;
  hint: string;
  initial: WorkingHours;
  // the range a newly ticked day starts with
  dayRange?: TimeRange;
  error?: string;
  // a note next to a day, e.g. "יום מנוחה של העסק"
  dayNotes?: Partial<Record<Weekday, string>>;
};

/**
 * Weekly working hours: per day a checkbox and 1 to 3 ranges (USR-01 split
 * hours). The fields are parsed by parseWorkingHours(); the form that holds
 * them must be submitted with submitWith (the checkboxes are controlled).
 */
export function HoursFields({ legend, hint, initial, dayRange = { start: "09:00", end: "17:00" }, error, dayNotes = {} }: Props) {
  const id = useId();
  const [days, setDays] = useState<Record<Weekday, boolean>>(
    () => Object.fromEntries(WEEKDAYS.map(({ key }) => [key, Boolean(initial[key])])) as Record<Weekday, boolean>,
  );
  const [ranges, setRanges] = useState<Record<Weekday, RangeRow[]>>(
    () =>
      Object.fromEntries(WEEKDAYS.map(({ key }) => [key, (initial[key] ?? [dayRange]).map((r, i) => ({ ...r, id: i }))])) as Record<Weekday, RangeRow[]>,
  );
  const changeRange = (day: Weekday, rangeId: number, field: "start" | "end", value: string) =>
    setRanges((current) => ({ ...current, [day]: current[day].map((r) => (r.id === rangeId ? { ...r, [field]: value } : r)) }));
  const addRange = (day: Weekday) =>
    setRanges((current) =>
      current[day].length >= MAX_DAY_RANGES
        ? current
        : { ...current, [day]: [...current[day], { ...nextRange(current[day]), id: Math.max(...current[day].map((r) => r.id)) + 1 }] },
    );
  // the remove button disappears with its range: keyboard focus goes to that day's "add" button
  const focusAdd = useRef<Weekday | null>(null);
  useEffect(() => {
    if (!focusAdd.current) return;
    document.getElementById(`${id}-add-${focusAdd.current}`)?.focus();
    focusAdd.current = null;
  });
  const removeRange = (day: Weekday, rangeId: number) => {
    setRanges((current) => (current[day].length <= 1 ? current : { ...current, [day]: current[day].filter((r) => r.id !== rangeId) }));
    focusAdd.current = day;
  };

  return (
    <fieldset aria-describedby={`${id}-hint`}>
      <legend className="text-md font-medium text-ink">{legend}</legend>
      <p id={`${id}-hint`} className="mt-1 text-sm text-ink-soft">
        {hint}
      </p>
      {error ? (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ul className="mt-3 divide-y divide-line rounded-md border border-line">
        {WEEKDAYS.map(({ key, label }) => {
          const on = days[key];
          const dayRanges = ranges[key];
          const many = dayRanges.length > 1;
          const note = dayNotes[key];
          return (
            <li key={key} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2">
              <label className="flex min-h-11 w-24 items-center gap-2 text-md text-ink">
                <input
                  type="checkbox"
                  name={`day_${key}`}
                  checked={on}
                  onChange={(e) => setDays((current) => ({ ...current, [key]: e.target.checked }))}
                  className="size-5 shrink-0 rounded-sm border-line-control accent-[var(--color-accent)]"
                />
                {label}
              </label>
              {on ? (
                <div className="flex flex-col gap-2">
                  {dayRanges.map((range, index) => {
                    const names = rangeFieldNames(key, index);
                    // the first range keeps the short name; the others say which one they are
                    const which = index === 0 ? "" : `, טווח ${index + 1}`;
                    return (
                      <span key={range.id} className="flex flex-wrap items-center gap-2">
                        <Input
                          type="time"
                          name={names.start}
                          value={range.start}
                          onChange={(e) => changeRange(key, range.id, "start", e.target.value)}
                          aria-label={`שעת התחלה ביום ${label}${which}`}
                          controlSize="sm"
                          className="w-28"
                          dir="ltr"
                          required
                        />
                        <span className="text-sm text-ink-soft">עד</span>
                        <Input
                          type="time"
                          name={names.end}
                          value={range.end}
                          onChange={(e) => changeRange(key, range.id, "end", e.target.value)}
                          aria-label={`שעת סיום ביום ${label}${which}`}
                          controlSize="sm"
                          className="w-28"
                          dir="ltr"
                          required
                        />
                        {many ? (
                          <IconButton
                            label={`הסרת טווח ${index + 1} ביום ${label}`}
                            icon={<CloseIcon className="size-5" />}
                            variant="danger-ghost"
                            onClick={() => removeRange(key, range.id)}
                          />
                        ) : null}
                      </span>
                    );
                  })}
                  {dayRanges.length < MAX_DAY_RANGES ? (
                    <Button
                      id={`${id}-add-${key}`}
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      aria-label={`הוספת טווח ביום ${label}`}
                      onClick={() => addRange(key)}
                    >
                      <PlusIcon className="size-4" />
                      הוספת טווח
                    </Button>
                  ) : null}
                  {note ? <span className="text-sm text-ink-soft">{note}</span> : null}
                </div>
              ) : (
                <span className="flex min-h-11 items-center text-sm text-ink-soft">{note ?? "לא עובדים"}</span>
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
