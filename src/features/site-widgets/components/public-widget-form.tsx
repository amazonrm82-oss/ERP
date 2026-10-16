"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { FormError } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { CheckIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { collectAttribution } from "@/features/intake/attribution";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";

import { widgetSubmitPath } from "../paths";

type Reply = { ok: true } | { ok: false; message: string };

/** SPD-07: the site widget's short form; posts to /api/forms/widget/<token>, and the lead goes through intake_submit. */
export function PublicWidgetForm({ token, business }: { token: string; business: string }) {
  const [startedAt] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "").trim();
    const wrong: Record<string, string> = {};
    if (!value("full_name")) wrong.full_name = "יש לכתוב שם.";
    if (!value("phone") && !value("email")) wrong.phone = "יש לכתוב טלפון או אימייל.";
    else if (value("phone") && value("phone").replace(/\D/g, "").length < 9) wrong.phone = "יש לכתוב מספר טלפון תקין.";
    setFieldErrors(wrong);
    if (Object.keys(wrong).length > 0) {
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setPending(true);
    try {
      const res = await fetch(widgetSubmitPath(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // CAP-02: the campaign keys of this page's address
          ...collectAttribution(window.location.href, document.referrer),
          full_name: value("full_name"),
          phone: value("phone"),
          email: value("email"),
          message: value("message"),
          [HONEYPOT_FIELD]: value(HONEYPOT_FIELD),
          [STARTED_AT_FIELD]: startedAt,
        }),
      });
      const reply = (await res.json()) as Reply;
      if (reply.ok) setDone(true);
      else setError(reply.message);
    } catch {
      setError("אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div ref={doneRef} tabIndex={-1} role="status" className="rounded-lg border border-line bg-surface p-5 text-center outline-none">
        <span aria-hidden="true" className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-accent text-on-accent">
          <CheckIcon className="size-6" />
        </span>
        <p className="text-lead font-semibold">הפרטים נשלחו</p>
        <p className="mt-1 text-md text-ink-soft">{business} יחזרו אליכם בהקדם.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormError message={error} />
      <TextField label="שם מלא" name="full_name" required autoComplete="name" maxLength={200} error={fieldErrors.full_name} />
      <TextField label="טלפון" name="phone" type="tel" autoComplete="tel" inputMode="tel" dir="ltr" maxLength={40} error={fieldErrors.phone} />
      <TextField label="אימייל" name="email" type="email" autoComplete="email" dir="ltr" maxLength={254} error={fieldErrors.email} />
      <TextareaField label="במה אפשר לעזור? (לא חובה)" name="message" rows={3} maxLength={2000} />
      {/* honeypot: hidden from people and from screen readers; bots fill it */}
      <div aria-hidden="true" className="absolute -start-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <SubmitButton pending={pending} pendingText="שולחים…" className="w-full">
        שליחת הפרטים
      </SubmitButton>
    </form>
  );
}
