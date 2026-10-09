"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CalendarIcon, ChevronIcon } from "@/components/ui/icons";
import { addDays, addMonths, longDay, monthGrid, monthTitle, shortDay, startOfWeek, WEEKDAYS_LONG, WEEKDAYS_SHORT } from "@/lib/calendar-grid";
import { isCalendarDate } from "@/lib/calendar-date";
import { cn } from "@/lib/cn";
import { zoneDate } from "@/lib/format";

type DateFieldProps = {
  label: string;
  // the form field that carries "YYYY-MM-DD" (empty when no day is picked)
  name?: string;
  defaultValue?: string;
  // controlled use: value + onChange
  value?: string;
  onChange?: (day: string) => void;
  min?: string;
  max?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  // the organization's time zone, for "today"
  timeZone?: string;
  className?: string;
};

/**
 * A Hebrew date field: weeks start on Sunday, months and days in Hebrew,
 * dd.mm.yyyy on the button. The calendar opens as a bottom sheet on a phone.
 * Keyboard: arrows move a day (right is back in Hebrew), Home/End the week,
 * PageUp/PageDown the month, Enter picks.
 */
export function DateField({ label, name, defaultValue = "", value, onChange, min, max, hint, error, required, disabled, timeZone, className }: DateFieldProps) {
  const [inner, setInner] = useState(defaultValue);
  const day = value ?? inner;
  const [open, setOpen] = useState(false);
  const id = useId();

  function pick(next: string) {
    if (value === undefined) setInner(next);
    onChange?.(next);
    setOpen(false);
  }

  return (
    <div className={className}>
      <span id={`${id}-label`} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
        {required ? (
          <span aria-hidden="true" className="ms-0.5 text-danger">
            *
          </span>
        ) : null}
      </span>
      {name ? <input type="hidden" name={name} value={day} /> : null}
      <button
        type="button"
        disabled={disabled}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onClick={() => setOpen(true)}
        className={cn(
          "flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-line-control bg-surface px-3 text-start text-ink",
          "disabled:bg-canvas disabled:text-ink-soft",
          error && "border-danger",
        )}
      >
        <span id={`${id}-value`} className={cn("tabular-nums", !day && "text-ink-soft")}>
          {day ? shortDay(day) : "בחירת תאריך"}
        </span>
        <CalendarIcon className="size-5 shrink-0 text-ink-soft" />
      </button>
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Dialog open={open} onClose={() => setOpen(false)} title={label} variant="sheet" className="sm:max-w-sm">
        {open ? (
          <Calendar
            selected={day}
            today={zoneDate(new Date(), timeZone)}
            min={min}
            max={max}
            onPick={pick}
            onClear={required ? undefined : () => pick("")}
            autoFocus
          />
        ) : null}
      </Dialog>
    </div>
  );
}

type CalendarProps = {
  selected: string;
  today: string;
  min?: string;
  max?: string;
  onPick: (day: string) => void;
  onClear?: () => void;
  // start with focus on the picked day (or today), as a calendar window should
  autoFocus?: boolean;
};

/** The month grid with roving focus; exported for the gallery. */
export function Calendar({ selected, today, min, max, onPick, onClear, autoFocus }: CalendarProps) {
  const [focus, setFocus] = useState(isCalendarDate(selected) ? selected : today);
  const gridRef = useRef<HTMLTableElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (!autoFocus) return;
    // a frame later: the dialog's showModal() runs after this effect and focuses its first button
    const frame = requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  useEffect(() => {
    // after a key moved the focus, put the browser's focus on the new day too
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus]);

  const allowed = (day: string) => (!min || day >= min) && (!max || day <= max);
  const move = (day: string) => {
    moved.current = true;
    setFocus(day);
  };

  function onKey(event: KeyboardEvent<HTMLTableElement>) {
    const keys: Record<string, () => string> = {
      // right-to-left: the day to the right is the day before
      ArrowRight: () => addDays(focus, -1),
      ArrowLeft: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      Home: () => startOfWeek(focus),
      End: () => addDays(startOfWeek(focus), 6),
      PageUp: () => addMonths(focus, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, event.shiftKey ? 12 : 1),
    };
    const target = keys[event.key];
    if (!target) return;
    event.preventDefault();
    move(target());
  }

  const month = focus.slice(0, 7);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <IconButton label="החודש הקודם" icon={<ChevronIcon className="size-5 rotate-180" />} onClick={() => setFocus(addMonths(focus, -1))} />
        <h3 aria-live="polite" className="font-semibold">
          {monthTitle(focus)}
        </h3>
        <IconButton label="החודש הבא" icon={<ChevronIcon className="size-5" />} onClick={() => setFocus(addMonths(focus, 1))} />
      </div>
      <table ref={gridRef} role="grid" aria-label={monthTitle(focus)} onKeyDown={onKey} className="mt-2 w-full table-fixed border-collapse text-center">
        <thead>
          <tr>
            {WEEKDAYS_SHORT.map((short, i) => (
              <th key={short} scope="col" abbr={WEEKDAYS_LONG[i]} className="pb-1 text-caption font-medium text-ink-soft">
                {short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(focus).map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const inMonth = day.slice(0, 7) === month;
                const isSelected = day === selected;
                return (
                  <td key={day} className="p-0.5">
                    <button
                      type="button"
                      data-day={day}
                      tabIndex={day === focus ? 0 : -1}
                      aria-label={longDay(day)}
                      aria-pressed={isSelected}
                      aria-current={day === today ? "date" : undefined}
                      disabled={!allowed(day)}
                      onClick={() => onPick(day)}
                      onFocus={() => setFocus(day)}
                      className={cn(
                        "mx-auto flex size-10 items-center justify-center rounded-full text-md tabular-nums disabled:cursor-not-allowed disabled:opacity-40",
                        isSelected ? "bg-accent font-semibold text-on-accent" : "hover:bg-canvas",
                        !isSelected && (inMonth ? "text-ink" : "text-ink-soft"),
                        day === today && !isSelected && "border border-accent font-semibold",
                      )}
                    >
                      {Number(day.slice(8, 10))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap justify-between gap-2">
        <Button variant="secondary" size="sm" onClick={() => onPick(today)} disabled={!allowed(today)}>
          היום
        </Button>
        {onClear ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            ניקוי
          </Button>
        ) : null}
      </div>
    </div>
  );
}
