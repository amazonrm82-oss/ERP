"use client";

import { useState, type FormEvent } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

import { HONEYPOT_FIELD, INTAKE_FIELD_LABELS, STARTED_AT_FIELD, type FormFieldConfig } from "../fields";
import { validatePublicForm } from "../public-validate";

type Props = { token: string; fields: FormFieldConfig[]; submitLabel: string };

/** The hosted lead form. Posts to /api/forms/<token>; works inside an iframe. */
export function PublicLeadForm({ token, fields, submitLabel }: Props) {
  const [startedAt] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one message per wrong field, next to it (FXA-02)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());
    const values = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : ""]));
    const wrong = validatePublicForm(fields, values);
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
        body: JSON.stringify({ ...body, [STARTED_AT_FIELD]: startedAt }),
      });
      const reply = (await res.json()) as { ok: boolean; message: string; redirectUrl?: string | null; field?: string };
      if (!reply.ok && reply.field && fields.some((field) => field.key === reply.field)) {
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
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormError message={error} />
      {fields.map((field) => {
        const common = { label: INTAKE_FIELD_LABELS[field.key], name: field.key, required: field.required, error: fieldErrors[field.key] };
        switch (field.key) {
          case "message":
            return <TextareaField key={field.key} {...common} rows={4} maxLength={5000} />;
          case "phone":
            return <TextField key={field.key} {...common} type="tel" dir="ltr" inputMode="tel" autoComplete="tel" />;
          case "email":
            return <TextField key={field.key} {...common} type="email" dir="ltr" inputMode="email" autoComplete="email" />;
          case "company_name":
            return <TextField key={field.key} {...common} maxLength={200} autoComplete="organization" />;
          default:
            return <TextField key={field.key} {...common} maxLength={200} autoComplete="name" />;
        }
      })}
      {/* honeypot: hidden from people and from screen readers; bots fill it */}
      <div aria-hidden="true" className="absolute -start-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <SubmitButton pending={pending} pendingText="שולח…" className="w-full">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
