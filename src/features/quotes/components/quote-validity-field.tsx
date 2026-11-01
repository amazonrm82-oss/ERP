"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { movedToWorkingDayNotice } from "@/features/calendar-days/rest-day-note";
import type { CalendarSettings } from "@/features/calendar-days/holidays";
import { RestDayWarning } from "@/features/tasks/components/rest-day-warning";
import { longDay } from "@/lib/calendar-grid";
import { formatDate } from "@/lib/format";

import { VALIDITY_CHOICES, validityDay, validityStart } from "../validity";

/** The business's calendar and today ("YYYY-MM-DD" in its zone), for the quick choices. */
export type ValidityCalendar = { calendar: CalendarSettings; today: string };

/**
 * QUO-02 + HEB-03: a draft quote's "valid until" date with quick choices counted from
 * the quote's date in business days of the business (or plain days, moved off a rest
 * day). A picked rest day only warns (HEB-02's RestDayWarning); the form saves the
 * date in the field, whatever filled it.
 */
export function QuoteValidityField({
  initial,
  quoteDate,
  error,
  validity,
}: {
  initial: string;
  quoteDate: string;
  error?: string;
  validity: ValidityCalendar | null;
}) {
  const [day, setDay] = useState(initial);
  const [said, setSaid] = useState("");
  const from = validity ? validityStart(quoteDate, validity.today) : quoteDate;

  function pick(index: number) {
    if (!validity) return;
    const result = validityDay(validity.calendar, from, VALIDITY_CHOICES[index]);
    if (!result) {
      setSaid("לא נמצא יום עבודה קרוב.");
      return;
    }
    setDay(result.day);
    setSaid(result.moved ? `בתוקף עד: ${movedToWorkingDayNotice(result.day)}` : `בתוקף עד ${longDay(result.day)}`);
  }

  return (
    <div className="space-y-2 sm:max-w-md">
      <DateField
        label="בתוקף עד"
        name="valid_until"
        value={day}
        onChange={(next) => {
          setDay(next);
          setSaid("");
        }}
        min={quoteDate}
        hint={`תאריך ההצעה: ${formatDate(quoteDate)}`}
        error={error}
        className="sm:max-w-xs"
      />
      {validity ? (
        <>
          <RestDayWarning
            calendar={validity.calendar}
            day={day}
            onMove={(next) => {
              setDay(next);
              setSaid("");
            }}
          />
          <div role="group" aria-label="קיצורים לתוקף ההצעה" className="flex flex-wrap gap-2">
            {VALIDITY_CHOICES.map((choice, index) => (
              <Button key={choice.key} variant="secondary" size="sm" aria-label={choice.ariaLabel} onClick={() => pick(index)}>
                {choice.label}
              </Button>
            ))}
          </div>
          <p className="text-sm text-ink-soft" aria-live="polite">
            {said || "ימי עסקים נספרים מתאריך ההצעה, בלי ימי המנוחה והחגים של העסק."}
          </p>
        </>
      ) : null}
    </div>
  );
}
