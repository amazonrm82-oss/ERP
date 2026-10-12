"use client";

import { useId, useState, type KeyboardEvent } from "react";

import { Input, Label } from "@/components/ui/field";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/cn";

import type { MentionCandidate } from "../token";

type Props = {
  candidates: MentionCandidate[];
  onPick: (candidate: MentionCandidate) => void;
  triggerClassName?: string;
};

/**
 * REC-02: the "אזכור" button above a note. It lists the colleagues who may see the record
 * (the database checks again on save); picking one writes the mention into the text.
 * A combobox: focus stays in the search box, the arrow keys move the marked option
 * (aria-activedescendant), Enter picks it (never saves the note's form), and the number of
 * matches is announced.
 */
export function MentionPicker({ candidates, onPick, triggerClassName }: Props) {
  return (
    <Popover trigger="אזכור" label="אזכור של מישהו מהצוות" align="start" triggerClassName={triggerClassName}>
      {(close) => (
        <MentionList
          candidates={candidates}
          onPick={(candidate) => {
            close();
            onPick(candidate);
          }}
        />
      )}
    </Popover>
  );
}

// mounted each time the panel opens, so the search and the marked option start fresh
function MentionList({ candidates, onPick }: { candidates: MentionCandidate[]; onPick: (candidate: MentionCandidate) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const baseId = useId();
  const searchId = `${baseId}-search`;
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const needle = query.trim().toLowerCase();
  const shown = needle === "" ? candidates : candidates.filter((c) => c.name.toLowerCase().includes(needle));
  const current = shown.length === 0 ? -1 : Math.min(active, shown.length - 1);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + shown.length) % shown.length);
    } else if (event.key === "Home" || event.key === "End") {
      if (shown.length === 0) return;
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : shown.length - 1);
    } else if (event.key === "Enter") {
      // inside the note's form: Enter picks, it does not save
      event.preventDefault();
      if (current >= 0) onPick(shown[current]);
    }
  }

  const status =
    candidates.length === 0
      ? "אין עוד מישהו בצוות שרואה את הרשומה הזו."
      : shown.length === 0
        ? "לא נמצא מישהו בשם הזה."
        : shown.length === 1
          ? "נמצא אדם אחד. Enter בוחר."
          : `נמצאו ${shown.length} אנשים. החצים עוברים ביניהם, Enter בוחר.`;

  return (
    <div className="p-3">
      <Label htmlFor={searchId}>את מי לאזכר?</Label>
      <Input
        id={searchId}
        type="text"
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        autoFocus
      />
      <p role="status" aria-live="polite" className="mt-2 text-sm text-ink-soft">
        {status}
      </p>
      <ul id={listId} role="listbox" aria-label="אנשים שאפשר לאזכר" className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
        {shown.map((candidate, index) => (
          <li
            key={candidate.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === current}
            // the search box keeps focus; a click picks
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(candidate)}
            className={cn(
              "flex min-h-11 cursor-pointer items-center rounded-md px-2 text-md text-ink hover:bg-canvas",
              index === current && "bg-accent-soft text-accent-strong",
            )}
          >
            {candidate.name}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-ink-soft">מי שמאוזכר מקבל התראה עם קישור לרשומה.</p>
    </div>
  );
}
