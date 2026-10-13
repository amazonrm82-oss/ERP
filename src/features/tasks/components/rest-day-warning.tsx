"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { CalendarSettings } from "@/features/calendar-days/holidays";
import { restDayNote } from "@/features/calendar-days/rest-day-note";

/**
 * HEB-02: watches the date field of the same form (named `field`) and, when the
 * chosen day is a rest day or holiday of the business, says so and offers the
 * next working day. Only a warning: the form still saves the date as chosen.
 */
export function RestDayWarning({ calendar, field = "due_date", initial = "" }: { calendar: CalendarSettings; field?: string; initial?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // the field's starting value comes in as `initial`; later changes are read from the field
  const [day, setDay] = useState(initial);

  useEffect(() => {
    const form = ref.current?.closest("form");
    const input = form?.querySelector<HTMLInputElement>(`input[name="${field}"]`);
    if (!form || !input) return;
    const read = () => setDay(input.value);
    // after a reset the browser restores the default value only once the event is done
    const reset = () => setTimeout(read, 0);
    input.addEventListener("input", read);
    input.addEventListener("change", read);
    form.addEventListener("reset", reset);
    return () => {
      input.removeEventListener("input", read);
      input.removeEventListener("change", read);
      form.removeEventListener("reset", reset);
    };
  }, [field]);

  const note = restDayNote(day, calendar);

  function move() {
    if (!note?.next) return;
    const input = ref.current?.closest("form")?.querySelector<HTMLInputElement>(`input[name="${field}"]`);
    if (!input) return;
    input.value = note.next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
  }

  return (
    <div ref={ref} aria-live="polite">
      {note ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
          <p className="min-w-0 flex-[1_1_12rem]">{note.text}</p>
          {note.moveLabel ? (
            <Button variant="secondary" size="sm" onClick={move}>
              {note.moveLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
