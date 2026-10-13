"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Input, Label, Select } from "@/components/ui/field";
import {
  addBusinessDays,
  BUSINESS_DAY_CHOICES,
  BUSINESS_DAYS_FREE_MAX,
  parseBusinessDays,
} from "@/features/calendar-days/business-days";
import type { CalendarSettings } from "@/features/calendar-days/holidays";
import { longDay } from "@/lib/calendar-grid";

export type BusinessDaysContext = { calendar: CalendarSettings; today: string };

const OTHER = "other";

/**
 * HEB-03: "in N business days" next to a task's due date. A quick choice that
 * fills the date field of the same form (named `field`), counted from today in
 * the business's zone and skipping its rest days. The date field stays the
 * source of truth: the user may still change it, and nothing of this is sent.
 */
export function BusinessDaysPicker({ calendar, today, field = "due_date" }: BusinessDaysContext & { field?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [choice, setChoice] = useState("");
  const [free, setFree] = useState("");
  const [said, setSaid] = useState("");

  // React resets the form after a successful save: start over with it, so the
  // picker does not keep showing (and announcing) the previous choice.
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const clear = () => {
      setChoice("");
      setFree("");
      setSaid("");
    };
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  function apply(n: number | null) {
    if (n === null) return;
    let day: string;
    try {
      day = addBusinessDays(calendar, today, n);
    } catch {
      setSaid("לא נמצא יום עבודה קרוב.");
      return;
    }
    const input = ref.current?.closest("form")?.querySelector<HTMLInputElement>(`input[name="${field}"]`);
    if (input) {
      input.value = day;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setSaid(`תאריך היעד: ${longDay(day)}`);
  }

  const freeInvalid = choice === OTHER && free !== "" && parseBusinessDays(free) === null;

  return (
    <div ref={ref} className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${id}-choice`}>בעוד ימי עסקים</Label>
          <Select
            id={`${id}-choice`}
            value={choice}
            onChange={(event) => {
              const value = event.target.value;
              setChoice(value);
              if (value === OTHER) {
                apply(parseBusinessDays(free));
              } else if (value !== "") {
                apply(Number(value));
              } else {
                setSaid("");
              }
            }}
          >
            <option value="">לפי התאריך שבחרתם</option>
            {BUSINESS_DAY_CHOICES.map((n) => (
              <option key={n} value={String(n)}>
                {n === 1 ? "יום עסקים אחד" : `${n} ימי עסקים`}
              </option>
            ))}
            <option value={OTHER}>מספר אחר…</option>
          </Select>
        </div>
        {choice === OTHER ? (
          <div className="w-28">
            <Label htmlFor={`${id}-free`}>כמה ימים</Label>
            <Input
              id={`${id}-free`}
              type="number"
              inputMode="numeric"
              dir="ltr"
              min={1}
              max={BUSINESS_DAYS_FREE_MAX}
              value={free}
              aria-invalid={freeInvalid ? true : undefined}
              aria-describedby={freeInvalid ? `${id}-free-error` : undefined}
              onChange={(event) => {
                setFree(event.target.value);
                apply(parseBusinessDays(event.target.value));
              }}
            />
          </div>
        ) : null}
      </div>
      {freeInvalid ? (
        <p id={`${id}-free-error`} className="text-sm text-danger">
          מספר שלם בין 1 ל-{BUSINESS_DAYS_FREE_MAX}.
        </p>
      ) : null}
      <p className="text-sm text-ink-soft" aria-live="polite">
        {said || "מדלגים על ימי המנוחה והחגים של העסק."}
      </p>
    </div>
  );
}
