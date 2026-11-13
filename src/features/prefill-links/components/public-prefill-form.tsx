"use client";

import { useMemo, useState, type FormEvent } from "react";

import { FormError } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";
import { displayCustomFields, inputValue, parseCustomFields } from "@/features/custom-fields/values";
import type { Json } from "@/lib/database.types";

import type { PrefillField } from "../public";

type Props = { submitPath: string; fields: PrefillField[] };

const isCustom = (key: string) => key.startsWith("cf:");
const inputNameOf = (key: string) => (isCustom(key) ? `cf_${key.slice(3)}` : key);

function definitionOf(field: PrefillField): FieldDefinition {
  return {
    id: field.key,
    key: field.key.slice(3),
    label: field.label,
    type: field.type as FieldType,
    options: field.options,
    isRequired: field.required,
    isActive: true,
    helpText: field.help,
  };
}

/**
 * BIZ-05: the customer's form, filled with what the business already holds. Only the template's fields; a read-only field
 * that holds a value is shown as text. An empty answer leaves the stored value (the business never loses data by a blank).
 */
export function PublicPrefillForm({ submitPath, fields }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ skipped: string[] } | null>(null);
  const definitions = useMemo(() => fields.filter((f) => isCustom(f.key) && !f.readOnly).map(definitionOf), [fields]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const parsed = parseCustomFields(definitions, form);
    const errors: Record<string, string> = { ...parsed.errors };
    const values: Record<string, Json> = {};
    for (const field of fields) {
      if (field.readOnly) continue;
      if (isCustom(field.key)) {
        const value = parsed.values[field.key.slice(3)];
        if (value !== undefined) values[field.key] = value as Json;
      } else {
        const raw = form.get(field.key);
        values[field.key] = typeof raw === "string" ? raw.trim() : "";
        if (field.type === "email" && values[field.key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values[field.key]))) {
          errors[field.key] = "כתובת האימייל לא תקינה. לדוגמה: name@example.co.il";
        }
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setPending(true);
    try {
      const response = await fetch(submitPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const reply = (await response.json().catch(() => null)) as
        | { ok: true; skipped: string[] }
        | { ok: false; message: string; field?: string }
        | null;
      if (reply?.ok) {
        setDone({ skipped: reply.skipped ?? [] });
        return;
      }
      if (reply && !reply.ok && reply.field) {
        setFieldErrors({ [inputNameOf(reply.field)]: "הערך אינו תקין." });
      }
      setError(reply && !reply.ok ? reply.message : "משהו השתבש. נסו שוב בעוד רגע.");
    } catch {
      setError("אין חיבור כרגע. נסו שוב בעוד רגע.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="space-y-2 rounded-md bg-success-soft px-4 py-3 text-success">
        <p className="flex items-center gap-2 text-md font-medium">
          <CheckIcon className="size-5 shrink-0" />
          הפרטים נשלחו. תודה!
        </p>
        {done.skipped.length > 0 ? (
          <p className="text-sm">את הפרטים האלה העסק יעדכן בעצמו: {done.skipped.join(", ")}.</p>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
      {fields.map((field) => (
        <PrefillInput key={field.key} field={field} error={fieldErrors[inputNameOf(field.key)]} />
      ))}
      <FormError message={error} />
      <SubmitButton pending={pending} pendingText="שולחים…">
        שליחה
      </SubmitButton>
    </form>
  );
}

function PrefillInput({ field, error }: { field: PrefillField; error?: string }) {
  const name = inputNameOf(field.key);
  const hint = field.help ?? undefined;
  const common = { label: field.label, name, required: field.required, hint, error };

  if (!isCustom(field.key)) {
    const value = typeof field.value === "string" ? field.value : "";
    // a stored email or phone is shown, not asked (the business changes it itself)
    if (field.readOnly) {
      return (
        <div>
          <p className="mb-1.5 text-sm font-medium">{field.label}</p>
          <p className="text-md">
            <bdi dir="ltr">{value}</bdi>
          </p>
        </div>
      );
    }
    switch (field.type) {
      case "phone":
        return <TextField {...common} type="tel" dir="ltr" inputMode="tel" autoComplete="tel" maxLength={40} defaultValue={value} />;
      case "email":
        return <TextField {...common} type="email" dir="ltr" inputMode="email" autoComplete="email" maxLength={254} defaultValue={value} />;
      case "date":
        return <TextField {...common} type="date" defaultValue={value} />;
      default:
        return <TextField {...common} maxLength={200} defaultValue={value} />;
    }
  }

  const definition = definitionOf(field);
  const stored = { [definition.key]: field.value };
  if (field.readOnly) {
    const [shown] = displayCustomFields([definition], stored);
    return (
      <div>
        <p className="mb-1.5 text-sm font-medium">{field.label}</p>
        <p className="text-md" dir={shown?.ltr ? "ltr" : undefined}>
          {shown?.text}
        </p>
      </div>
    );
  }
  const value = inputValue(definition, stored);
  const star = field.required ? (
    <span aria-hidden="true" className="ms-0.5 text-danger">
      *
    </span>
  ) : null;
  const below = error ? <p className="mt-1.5 text-sm text-danger">{error}</p> : hint ? <p className="mt-1.5 text-sm text-ink-soft">{hint}</p> : null;

  switch (field.type) {
    case "long_text":
      return <TextareaField {...common} rows={3} maxLength={5000} defaultValue={value} />;
    case "select":
      return (
        <SelectField {...common} defaultValue={field.options.includes(value) ? value : ""}>
          <option value="">לא נבחר</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SelectField>
      );
    case "rating":
      return (
        <SelectField {...common} defaultValue={value}>
          <option value="">לא נבחר</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={String(n)}>
              {n} מתוך 5
            </option>
          ))}
        </SelectField>
      );
    case "checkbox":
      return (
        <div>
          <label className="flex min-h-11 items-center gap-2.5 text-md">
            <input type="checkbox" name={name} defaultChecked={value === "on"} aria-invalid={error ? true : undefined} className="size-4.5 accent-accent" />
            {field.label}
            {star}
          </label>
          {below}
        </div>
      );
    case "multi_select": {
      const picked = new Set(value.split("\n"));
      return (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">
            {field.label}
            {star}
          </legend>
          <div className="flex flex-wrap gap-x-4">
            {field.options.map((option) => (
              <label key={option} className="flex min-h-11 items-center gap-2 text-md">
                <input type="checkbox" name={name} value={option} defaultChecked={picked.has(option)} className="size-4.5 accent-accent" />
                {option}
              </label>
            ))}
          </div>
          {below}
        </fieldset>
      );
    }
    case "currency":
      return <TextField {...common} hint={hint ?? "בשקלים"} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
    case "percent":
      return <TextField {...common} hint={hint ?? "באחוזים"} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
    case "number":
      return <TextField {...common} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
    case "date":
      return <TextField {...common} type="date" defaultValue={value} />;
    case "datetime":
      return <TextField {...common} type="datetime-local" defaultValue={value} />;
    case "il_id":
    case "il_company_id":
      return <TextField {...common} dir="ltr" inputMode="numeric" maxLength={11} autoComplete="off" defaultValue={value} />;
    case "phone":
      return <TextField {...common} type="tel" dir="ltr" inputMode="tel" autoComplete="off" defaultValue={value} />;
    case "email":
      return <TextField {...common} type="email" dir="ltr" inputMode="email" autoComplete="off" defaultValue={value} />;
    case "url":
      return <TextField {...common} dir="ltr" inputMode="url" autoComplete="off" defaultValue={value} />;
    case "address":
      return <TextField {...common} maxLength={500} autoComplete="street-address" defaultValue={value} />;
    default:
      return <TextField {...common} maxLength={500} autoComplete="off" defaultValue={value} />;
  }
}
