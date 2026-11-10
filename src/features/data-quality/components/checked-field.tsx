"use client";

import { useId, useState, type ComponentProps } from "react";

import { TextField } from "@/components/ui/field";

import { emailWarning, phoneWarning, type TypingWarning } from "../typing";

export type CheckKind = "phone" | "email";

/** The warning for a value, by kind. */
export function warningFor(kind: CheckKind, value: string): TypingWarning | null {
  return kind === "phone" ? phoneWarning(value) : emailWarning(value);
}

/** DQL-02: a warning under a phone or email box, with a one-click fix when there is one. Never blocks saving. */
export function TypingWarningLine({ id, warning, onFix }: { id: string; warning: TypingWarning; onFix: (value: string) => void }) {
  return (
    <p id={id} role="status" className="mt-1.5 text-sm text-warning">
      {warning.message}
      {warning.suggestion ? (
        <>
          {" "}
          <button
            type="button"
            onClick={() => onFix(warning.suggestion!)}
            className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4 hover:text-accent-strong sm:min-h-0"
          >
            <span>
              לתקן ל-<bdi dir="ltr">{warning.suggestion}</bdi>
            </span>
          </button>
        </>
      ) : null}
    </p>
  );
}

type Props = Omit<ComponentProps<typeof TextField>, "value" | "onChange" | "defaultValue" | "onPaste"> & {
  check: CheckKind;
  defaultValue?: string | null;
  // UX-03: told every value the box takes (typed, pasted, fixed), e.g. for a duplicate check while typing
  onValueChange?: (value: string) => void;
  // UX-03: a pasted text's clean form, or null to paste it unchanged; used only when the whole box is replaced
  cleanPaste?: (text: string) => string | null;
};

/**
 * DQL-02: a phone or email field that warns while typing (Israeli number, common email domain
 * typos). The warning shows once the user has left the box, and stays in step while
 * they go on typing.
 */
export function CheckedTextField({ check, defaultValue, error, onValueChange, cleanPaste, ...props }: Props) {
  const [value, setStoredValue] = useState(defaultValue ?? "");
  const setValue = (next: string) => {
    setStoredValue(next);
    onValueChange?.(next);
  };
  const [touched, setTouched] = useState(false);
  const warningId = useId();
  // a field error (the save was refused) wins over a warning
  const visible = !error && touched ? warningFor(check, value) : null;

  return (
    <div>
      <TextField
        {...props}
        error={error}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPaste={
          cleanPaste
            ? (event) => {
                const box = event.currentTarget;
                // a paste into part of the text is left alone: only a paste that replaces the whole box is cleaned
                const whole = box.value === "" || (box.selectionStart === 0 && box.selectionEnd === box.value.length);
                const cleaned = whole ? cleanPaste(event.clipboardData.getData("text")) : null;
                if (cleaned !== null) {
                  event.preventDefault();
                  setValue(cleaned);
                }
              }
            : undefined
        }
        onBlur={() => setTouched(true)}
        {...(visible ? { "aria-describedby": warningId } : {})}
      />
      {visible ? (
        <TypingWarningLine
          id={warningId}
          warning={visible}
          onFix={setValue}
        />
      ) : null}
    </div>
  );
}
