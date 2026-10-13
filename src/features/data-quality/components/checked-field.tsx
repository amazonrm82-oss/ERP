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

type Props = Omit<ComponentProps<typeof TextField>, "value" | "onChange" | "defaultValue"> & {
  check: CheckKind;
  defaultValue?: string | null;
};

/**
 * DQL-02: a phone or email field that warns while typing (Israeli number, common email domain
 * typos). The warning shows once the user has left the box, and stays in step while
 * they go on typing.
 */
export function CheckedTextField({ check, defaultValue, error, ...props }: Props) {
  const [value, setValue] = useState(defaultValue ?? "");
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
