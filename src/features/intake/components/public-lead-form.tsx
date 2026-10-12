"use client";

import { useMemo, useState, type FormEvent } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

import { collectAttribution } from "../attribution";
import { formInputName, HONEYPOT_FIELD, STARTED_AT_FIELD } from "../fields";
import { checkSubmission, type PublicField, type RawValues } from "../public-validate";

type Props = { token: string; fields: PublicField[]; submitLabel: string };

/** The form's inputs by name; a name sent more than once (a multiple choice) becomes a list. */
function rawValues(form: HTMLFormElement): RawValues {
  const out: RawValues = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value !== "string") continue;
    const before = out[key];
    out[key] = before === undefined ? value : Array.isArray(before) ? [...before, value] : [before, value];
  }
  return out;
}

/** The hosted lead form. Posts to /api/forms/<token>; works inside an iframe. */
export function PublicLeadForm({ token, fields, submitLabel }: Props) {
  const [startedAt] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one message per wrong field, next to it (FXA-02)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  // what is typed so far, for the conditional fields (CAP-01)
  const [values, setValues] = useState<RawValues>({});
  const visible = useMemo(() => checkSubmission(fields, values).visible, [fields, values]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const body = rawValues(form);
    const wrong = checkSubmission(fields, body).errors;
    setFieldErrors(wrong);
    if (Object.keys(wrong).length > 0) {
      // the first wrong field gets focus, and with it its label and message are read out
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/forms/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // CAP-02: UTM, click ids, referrer and landing page, from this page's address
        body: JSON.stringify({ ...collectAttribution(window.location.href, document.referrer), ...body, [STARTED_AT_FIELD]: startedAt }),
      });
      const reply = (await res.json()) as { ok: boolean; message: string; redirectUrl?: string | null; field?: string };
      if (!reply.ok && reply.field && fields.some((field) => formInputName(field.key) === reply.field)) {
        setFieldErrors({ [reply.field]: reply.message });
      } else if (!reply.ok) {
        setError(reply.message);
      } else if (reply.redirectUrl) {
        // leave the iframe too, when the form is embedded
        (window.top ?? window).location.href = reply.redirectUrl;
      } else {
        setDone(reply.message);
      }
    } catch {
      setError("אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return <FormNotice message={done} />;
  }

  return (
    <form onSubmit={submit} onChange={(event) => setValues(rawValues(event.currentTarget))} className="space-y-4" noValidate>
      <FormError message={error} />
      {fields.map((field) =>
        visible.has(field.key) ? <PublicInput key={field.key} field={field} error={fieldErrors[formInputName(field.key)]} /> : null,
      )}
      {/* honeypot: hidden from people and from screen readers; bots fill it */}
      <div aria-hidden="true" className="absolute -start-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <SubmitButton pending={pending} pendingText="שולחים…" className="w-full">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}

function PublicInput({ field, error }: { field: PublicField; error?: string }) {
  const name = formInputName(field.key);
  const label = field.label ?? field.key;
  const hint = field.help ?? undefined;
  const common = { label, name, required: field.required, hint, error };
  const custom = field.custom;

  if (!custom) {
    switch (field.key) {
      case "message":
        return <TextareaField {...common} rows={4} maxLength={5000} />;
      case "phone":
        return <TextField {...common} type="tel" dir="ltr" inputMode="tel" autoComplete="tel" />;
      case "email":
        return <TextField {...common} type="email" dir="ltr" inputMode="email" autoComplete="email" />;
      case "company_name":
        return <TextField {...common} maxLength={200} autoComplete="organization" />;
      default:
        return <TextField {...common} maxLength={200} autoComplete="name" />;
    }
  }

  const describedBy = error ? `${name}-error` : hint ? `${name}-hint` : undefined;
  const below = (
    <>
      {error ? (
        <p id={`${name}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${name}-hint`} className="mt-1.5 text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
    </>
  );
  const star = field.required ? (
    <span aria-hidden="true" className="ms-0.5 text-danger">
      *
    </span>
  ) : null;

  switch (custom.type) {
    case "long_text":
      return <TextareaField {...common} rows={3} maxLength={5000} />;
    case "select":
      return (
        <SelectField {...common} defaultValue="">
          <option value="">לא נבחר</option>
          {custom.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SelectField>
      );
    case "rating":
      return (
        <SelectField {...common} defaultValue="">
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
            <input
              type="checkbox"
              name={name}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              className="size-4.5 accent-accent"
            />
            {label}
            {star}
          </label>
          {below}
        </div>
      );
    case "multi_select":
      return (
        <fieldset aria-describedby={describedBy}>
          <legend className="mb-1.5 text-sm font-medium">
            {label}
            {star}
          </legend>
          <div className="flex flex-wrap gap-x-4">
            {custom.options.map((option, i) => (
              <label key={option} className="flex min-h-11 items-center gap-2 text-md">
                <input
                  type="checkbox"
                  name={name}
                  value={option}
                  aria-invalid={error && i === 0 ? true : undefined}
                  className="size-4.5 accent-accent"
                />
                {option}
              </label>
            ))}
          </div>
          {below}
        </fieldset>
      );
    case "currency":
      return <TextField {...common} hint={hint ?? "בשקלים"} dir="ltr" inputMode="decimal" autoComplete="off" />;
    case "percent":
      return <TextField {...common} hint={hint ?? "באחוזים"} dir="ltr" inputMode="decimal" autoComplete="off" />;
    case "number":
      return <TextField {...common} dir="ltr" inputMode="decimal" autoComplete="off" />;
    case "date":
      return <TextField {...common} type="date" />;
    case "datetime":
      return <TextField {...common} type="datetime-local" />;
    case "il_id":
    case "il_company_id":
      return <TextField {...common} dir="ltr" inputMode="numeric" maxLength={11} autoComplete="off" />;
    case "phone":
      return <TextField {...common} type="tel" dir="ltr" inputMode="tel" autoComplete="off" />;
    case "email":
      return <TextField {...common} type="email" dir="ltr" inputMode="email" autoComplete="off" />;
    case "url":
      return <TextField {...common} dir="ltr" inputMode="url" autoComplete="off" />;
    default:
      return <TextField {...common} maxLength={500} autoComplete="off" />;
  }
}
