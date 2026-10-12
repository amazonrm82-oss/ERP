"use client";

import { useId, useRef, type KeyboardEvent } from "react";

import { Label, Textarea } from "@/components/ui/field";
import { MentionPicker } from "@/features/mentions/components/mention-picker";
import { mentionToken, type MentionCandidate } from "@/features/mentions/token";
import { cn } from "@/lib/cn";

import { applyFormat, type FormatKind } from "../note-format";

const BUTTONS: Array<{ kind: FormatKind; label: string; shortcut?: string; textClass?: string }> = [
  { kind: "bold", label: "מודגש", shortcut: "Control+B", textClass: "font-bold" },
  { kind: "bullets", label: "רשימה" },
  { kind: "numbers", label: "רשימה ממוספרת" },
  { kind: "link", label: "קישור", shortcut: "Control+K", textClass: "underline underline-offset-4" },
];

const BUTTON_CLASS = "min-h-9 rounded-md border border-line px-2.5 text-sm text-ink hover:bg-canvas";

type Props = {
  label: string;
  name: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  defaultValue?: string;
  error?: string;
  autoFocus?: boolean;
  // REC-02: colleagues who may be mentioned; no "אזכור" button without them
  mentions?: MentionCandidate[];
};

/**
 * A note's text box with formatting buttons (REC-04): bold, lists and links, written as
 * Markdown into the text itself, so the text stays plain and safe. The buttons are ordinary
 * buttons in the tab order; Ctrl+B and Ctrl+K work inside the box.
 */
export function NoteEditor({ label, name, rows = 3, maxLength = 5000, placeholder, defaultValue, error, autoFocus, mentions }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  function format(kind: FormatKind) {
    const box = ref.current;
    if (!box) return;
    const edit = applyFormat(box.value, box.selectionStart, box.selectionEnd, kind);
    if (edit.value.length > maxLength) return;
    box.focus();
    // replaces the whole text in one step the browser can undo (Ctrl+Z)
    box.setSelectionRange(0, box.value.length);
    if (!document.execCommand?.("insertText", false, edit.value)) {
      box.value = edit.value;
    }
    box.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  }

  // REC-02: writes the mention where the cursor was (a text box keeps its selection while closed)
  function mention(candidate: MentionCandidate) {
    const box = ref.current;
    if (!box) return;
    const start = box.selectionStart;
    const end = box.selectionEnd;
    const before = box.value.slice(0, start);
    const text = `${before === "" || /\s$/.test(before) ? "" : " "}${mentionToken(candidate.id, candidate.name)} `;
    if (box.value.length - (end - start) + text.length > maxLength) return;
    box.focus();
    box.setSelectionRange(start, end);
    if (!document.execCommand?.("insertText", false, text)) {
      box.setRangeText(text, start, end, "end");
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    // by physical key too, so the shortcut works with a Hebrew keyboard layout
    if (key === "b" || event.code === "KeyB") {
      event.preventDefault();
      format("bold");
    } else if (key === "k" || event.code === "KeyK") {
      event.preventDefault();
      format("link");
    }
  }

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div role="group" aria-label="עיצוב הטקסט" className="mb-1.5 flex flex-wrap gap-1">
        {BUTTONS.map((button) => (
          <button
            key={button.kind}
            type="button"
            aria-controls={id}
            aria-keyshortcuts={button.shortcut}
            title={button.shortcut ? `${button.label} (${button.shortcut.replace("Control", "Ctrl")})` : undefined}
            // keep the selection in the text box while the button is pressed
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format(button.kind)}
            className={cn(BUTTON_CLASS, button.textClass)}
          >
            {button.label}
          </button>
        ))}
        {mentions ? <MentionPicker candidates={mentions} onPick={mention} triggerClassName={BUTTON_CLASS} /> : null}
      </div>
      <Textarea
        ref={ref}
        id={id}
        name={name}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        defaultValue={defaultValue}
        autoFocus={autoFocus}
        onKeyDown={onKeyDown}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-ink-soft">
          אפשר גם להקליד: **מודגש**, שורה שמתחילה ב-&quot;- &quot; לרשימה, [טקסט](https://…) לקישור.
          {mentions ? " כדי לאזכר מישהו מהצוות, לחצו על \"אזכור\"." : null}
        </p>
      )}
    </div>
  );
}
