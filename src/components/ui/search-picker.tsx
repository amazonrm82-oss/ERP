"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { cn } from "@/lib/cn";

import {
  hitsAnnouncement,
  moveActive,
  pickerLabelName,
  pickerQuery,
  SEARCH_PICKER_DELAY_MS,
  type SearchPickerChoice,
  type SearchPickerHit,
} from "./search-picker-logic";

export type { SearchPickerChoice, SearchPickerHit } from "./search-picker-logic";

/** What a search answers: the hits, or a message to show instead (a failed read is never "nothing found"). */
export type SearchPickerResult = { hits: SearchPickerHit[] } | { error: string };

type Props = {
  label: string;
  // visually hides the label (screen readers still read it)
  hideLabel?: boolean;
  // the form field that carries the picked id ("" = none); `${name}__label` carries its label
  name: string;
  initial: SearchPickerChoice;
  search: (query: string) => Promise<SearchPickerResult>;
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  // false: a pick can be replaced but not cleared (the form needs one)
  clearable?: boolean;
  onChange?: (choice: SearchPickerChoice) => void;
  className?: string;
};

/**
 * Pick one record by typing (a combobox): the search runs on the server with the user's session after a short pause, at
 * most a few hits come back, and arrows + Enter pick one (Escape closes the list, or goes back to the earlier pick). The
 * pick stays shown with "החלפה" (and "הסרה" when clearable). It replaces long <select> lists that could hold only part of
 * a business's records. Enter never sends the surrounding form.
 */
export function SearchPicker({
  label,
  hideLabel,
  name,
  initial,
  search,
  placeholder = "הקלידו שם, טלפון או אימייל",
  hint,
  error,
  required,
  clearable = true,
  onChange,
  className,
}: Props) {
  const [picked, setPicked] = useState<SearchPickerChoice>(initial);
  // searching while a pick exists: Escape goes back to it
  const [editing, setEditing] = useState(initial === null);
  const [typed, setTyped] = useState("");
  const [hits, setHits] = useState<SearchPickerHit[]>([]);
  const [answered, setAnswered] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const focusInput = useRef(false);
  const focusChange = useRef(false);
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const labelId = `${baseId}-label`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const query = pickerQuery(typed);

  useEffect(() => {
    if (query === null) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      let result: SearchPickerResult;
      try {
        result = await search(query);
      } catch {
        result = { error: "החיפוש נכשל. נסו שוב." };
      }
      // an older search that answers late never replaces a newer one
      if (mine !== seq.current) return;
      if ("error" in result) {
        setHits([]);
        setFailure(result.error);
      } else {
        setHits(result.hits);
        setFailure(null);
      }
      setAnswered(query);
      setActive(-1);
    }, SEARCH_PICKER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, search]);

  useEffect(() => {
    if (focusInput.current && editing) {
      focusInput.current = false;
      inputRef.current?.focus();
    }
    if (focusChange.current && !editing) {
      focusChange.current = false;
      changeRef.current?.focus();
    }
  }, [editing]);

  const shown = query !== null && answered === query ? hits : [];
  const listOpen = open && shown.length > 0;
  const status =
    query === null
      ? ""
      : answered !== query
        ? "מחפשים…"
        : failure
          ? failure
          : hitsAnnouncement(hits.length);

  function choose(choice: SearchPickerChoice) {
    setPicked(choice);
    setTyped("");
    setHits([]);
    setAnswered(null);
    setOpen(false);
    setActive(-1);
    onChange?.(choice);
    if (choice) {
      focusChange.current = true;
      setEditing(false);
    } else {
      focusInput.current = true;
      setEditing(true);
    }
  }

  function startEditing() {
    focusInput.current = true;
    setEditing(true);
  }

  function cancelEditing() {
    setTyped("");
    setOpen(false);
    setActive(-1);
    focusChange.current = true;
    setEditing(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      setOpen(true);
      setActive((current) => moveActive(listOpen ? current : -1, event.key, shown.length));
    } else if (event.key === "Enter") {
      // Enter picks; it never sends the form around the picker
      event.preventDefault();
      if (listOpen && active >= 0 && shown[active]) choose({ id: shown[active].id, label: shown[active].label });
    } else if (event.key === "Escape") {
      if (listOpen) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (picked) {
        event.preventDefault();
        cancelEditing();
      }
    }
  }

  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={className}>
      <input type="hidden" name={name} value={picked?.id ?? ""} />
      <input type="hidden" name={pickerLabelName(name)} value={picked?.label ?? ""} />
      {picked && !editing ? (
        <>
          <p id={labelId} className={cn("mb-1.5 block text-sm font-medium text-ink", hideLabel && "sr-only")}>
            {label}
            {required ? (
              <span aria-hidden="true" className="ms-0.5 text-danger">
                *
              </span>
            ) : null}
          </p>
          <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} className="flex flex-wrap items-center gap-2">
            <span className="min-h-11 min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-3 py-2.5 text-ink">
              <bdi>{picked.label}</bdi>
            </span>
            <span className="flex shrink-0 gap-1">
              <Button ref={changeRef} variant="ghost" size="sm" onClick={startEditing}>
                החלפה
                <span className="sr-only">: {label}</span>
              </Button>
              {clearable ? (
                <Button variant="ghost" size="sm" onClick={() => choose(null)}>
                  הסרה
                  <span className="sr-only">: {label}</span>
                </Button>
              ) : null}
            </span>
          </div>
        </>
      ) : (
        <>
          <Label htmlFor={inputId} className={hideLabel ? "sr-only" : undefined}>
            {label}
            {required ? (
              <span aria-hidden="true" className="ms-0.5 text-danger">
                *
              </span>
            ) : null}
          </Label>
          <div className="relative">
            <Input
              ref={inputRef}
              id={inputId}
              type="search"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={listOpen}
              aria-controls={listId}
              aria-activedescendant={listOpen && active >= 0 ? optionId(active) : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              autoComplete="off"
              enterKeyHint="search"
              placeholder={placeholder}
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setOpen(true);
                setActive(-1);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onKeyDown={onKeyDown}
            />
            <ul
              id={listId}
              role="listbox"
              aria-label={`תוצאות: ${label}`}
              hidden={!listOpen}
              className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-line bg-surface shadow-lg"
            >
              {shown.map((hit, index) => (
                <li
                  key={hit.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  className={cn("cursor-pointer px-3 py-2", index === active ? "bg-accent-soft" : "hover:bg-canvas")}
                  // keep the focus in the box, so the click picks before the list closes
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose({ id: hit.id, label: hit.label })}
                >
                  <span className="block break-words font-medium text-ink">
                    <bdi>{hit.label}</bdi>
                  </span>
                  {hit.detail ? (
                    <span dir="ltr" className="block text-end text-sm text-ink-soft">
                      {hit.detail}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          {picked ? (
            <p className="mt-1.5 text-sm">
              <Button variant="ghost" size="sm" onClick={cancelEditing}>
                ביטול ההחלפה
              </Button>
            </p>
          ) : null}
        </>
      )}
      <p role="status" aria-live="polite" className="mt-1 text-sm text-ink-soft empty:hidden">
        {editing || !picked ? status : ""}
      </p>
      {error ? (
        <p id={errorId} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="mt-1.5 text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
