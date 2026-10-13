"use client";

import { useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/field";
import { PencilIcon } from "@/components/ui/icons";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";

import { inlineEditAction, type InlineField, type InlineObject, type InlineValue } from "../actions";

// opensWindow: saving this choice hands it to onWindow instead (a deal entering a won stage, DEAL-04)
export type InlineOption = { value: string; label: string; needsReason?: boolean; opensWindow?: boolean };

type Props = {
  orgId: string;
  object: InlineObject;
  id: string;
  field: InlineField;
  // what the cell shows when it is not being edited
  children: ReactNode;
  // what is being edited, for screen readers ("שם: דנה כהן")
  label: string;
  // "text": one input; "person": first and last name; "select": a choice from options
  kind: "text" | "person" | "select";
  initial: InlineValue;
  options?: InlineOption[];
  // a choice for "nothing" (no owner), shown first
  emptyOption?: string;
  canEdit: boolean;
  // a choice that needs a reason: the organization's list (LEAD-03); empty: typed in freely
  reasons?: string[];
  // a choice marked opensWindow: the cell closes and this takes over (it saves, or not, itself)
  onWindow?: (value: string) => void;
};

/**
 * A list cell that can be edited in place (LST-06): a pencil opens a small form,
 * Enter saves and Escape cancels. The database decides whether the change is
 * allowed; the pencil is only a hint for who may edit.
 */
export function InlineEdit({ orgId, object, id, field, children, label, kind, initial, options = [], emptyOption, canEdit, reasons = [], onWindow }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<InlineValue>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pencil = useRef<HTMLButtonElement>(null);

  if (!canEdit) {
    return <>{children}</>;
  }

  const chosen = options.find((option) => option.value === value.id);

  function close(then?: () => void) {
    setEditing(false);
    setError(null);
    // back to the pencil, so the keyboard user stays in place (and a window opened next returns there)
    requestAnimationFrame(() => {
      pencil.current?.focus();
      then?.();
    });
  }

  function save() {
    setError(null);
    if (chosen?.opensWindow && onWindow) {
      const choice = chosen.value;
      close(() => onWindow(choice));
      return;
    }
    startTransition(async () => {
      const result = await inlineEditAction(orgId, object, id, field, value);
      if (result.ok) close();
      else setError(result.message);
    });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  if (!editing) {
    return (
      <span className="inline-flex max-w-full items-start gap-1">
        <span className="min-w-0">{children}</span>
        <button
          ref={pencil}
          type="button"
          aria-label={`עריכת ${label}`}
          title="עריכה"
          onClick={() => {
            setValue(initial);
            setEditing(true);
          }}
          className="shrink-0 rounded p-0.5 text-ink-soft hover:bg-canvas hover:text-ink"
        >
          <PencilIcon className="size-4" />
        </button>
      </span>
    );
  }

  return (
    <form
      className="min-w-40 space-y-1.5"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {kind === "person" ? (
        <>
          <Input
            aria-label={`שם פרטי (${label})`}
            placeholder="שם פרטי"
            controlSize="sm"
            autoFocus
            maxLength={100}
            value={value.first ?? ""}
            onChange={(e) => setValue({ ...value, first: e.target.value })}
          />
          <Input
            aria-label={`שם משפחה (${label})`}
            placeholder="שם משפחה"
            controlSize="sm"
            maxLength={100}
            value={value.last ?? ""}
            onChange={(e) => setValue({ ...value, last: e.target.value })}
          />
        </>
      ) : kind === "select" ? (
        <Select aria-label={label} controlSize="sm" autoFocus value={value.id ?? ""} onChange={(e) => setValue({ ...value, id: e.target.value || null })}>
          {emptyOption !== undefined ? <option value="">{emptyOption}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : (
        <Input aria-label={label} controlSize="sm" autoFocus maxLength={200} value={value.text ?? ""} onChange={(e) => setValue({ ...value, text: e.target.value })} />
      )}
      {chosen?.needsReason ? (
        <DisqualifyReasonField reasons={reasons} variant="bare" label="סיבה" controlSize="sm" value={value.reason ?? ""} onChange={(reason) => setValue({ ...value, reason })} />
      ) : null}
      <FormError message={error} />
      <div className="flex gap-1">
        <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
          {pending ? "שומרים…" : "שמירה"}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => close()}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
