"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { FormError } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { CheckIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";

import { DETAILS_MAX, NAME_MAX, PRIVACY_REQUEST_TYPES, privacySubmitPath, PUBLIC_TEXTS, publicRequestSchema, REQUEST_TYPE_LABELS } from "../model";

type Reply = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

/**
 * PRK-02: the public privacy-request form; posts to /api/forms/privacy/<token>. Only the request type, a name, one way to
 * reach the person and text. The answer is the same whatever the business holds.
 */
export function PublicPrivacyForm({ token }: { token: string }) {
  const [startedAt] = useState(() => Date.now());
  const [kind, setKind] = useState<"email" | "phone">("email");
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
    const value = (name: string) => String(data.get(name) ?? "");
    const body = {
      request_type: value("request_type"),
      name: value("name"),
      contact_kind: kind,
      contact_value: value("contact_value"),
      details: value("details"),
    };
    const parsed = publicRequestSchema.safeParse(body);
    if (!parsed.success) {
      const wrong: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "_form");
        if (!(key in wrong)) wrong[key] = issue.message;
      }
      setFieldErrors(wrong);
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      const res = await fetch(privacySubmitPath(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed.data, [HONEYPOT_FIELD]: value(HONEYPOT_FIELD), [STARTED_AT_FIELD]: startedAt }),
      });
      const reply = (await res.json()) as Reply;
      if (reply.ok) setDone(true);
      else {
        setError(reply.message);
        if (reply.fieldErrors) setFieldErrors(reply.fieldErrors);
      }
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
        <p className="text-lead font-semibold">{PUBLIC_TEXTS.received}</p>
        <p className="mt-1 text-md text-ink-soft">{PUBLIC_TEXTS.receivedLine}</p>
      </div>
    );
  }

  const typeError = fieldErrors.request_type;
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormError message={error} />
      <fieldset className="space-y-2" aria-describedby={typeError ? "privacy-type-error" : undefined}>
        <legend className="mb-1 text-sm font-medium">מה מבקשים?</legend>
        {PRIVACY_REQUEST_TYPES.map((type, index) => (
          <label key={type} className="flex items-start gap-2.5 text-md">
            <input type="radio" name="request_type" value={type} defaultChecked={index === 0} className="mt-1 size-4 accent-accent" />
            <span>{REQUEST_TYPE_LABELS[type]}</span>
          </label>
        ))}
        {typeError ? (
          <p id="privacy-type-error" className="text-sm text-danger">
            {typeError}
          </p>
        ) : null}
      </fieldset>
      <TextField label="שם מלא" name="name" required autoComplete="name" maxLength={NAME_MAX} error={fieldErrors.name} />
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">איך לחזור אליכם?</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-md">
            <input type="radio" name="contact_kind" value="email" checked={kind === "email"} onChange={() => setKind("email")} className="size-4 accent-accent" />
            <span>באימייל</span>
          </label>
          <label className="flex items-center gap-2 text-md">
            <input type="radio" name="contact_kind" value="phone" checked={kind === "phone"} onChange={() => setKind("phone")} className="size-4 accent-accent" />
            <span>בטלפון</span>
          </label>
        </div>
      </fieldset>
      {kind === "email" ? (
        <TextField key="email" label="אימייל" name="contact_value" type="email" required autoComplete="email" dir="ltr" maxLength={254} error={fieldErrors.contact_value} />
      ) : (
        <TextField key="phone" label="טלפון" name="contact_value" type="tel" required autoComplete="tel" inputMode="tel" dir="ltr" maxLength={40} error={fieldErrors.contact_value} />
      )}
      <TextareaField
        label="פרטים נוספים (לא חובה)"
        name="details"
        rows={4}
        maxLength={DETAILS_MAX}
        hint="למשל מה לתקן. אין צורך לצרף תעודה מזהה בשלב הזה."
        error={fieldErrors.details}
      />
      {/* honeypot: hidden from people and from screen readers; bots fill it */}
      <div aria-hidden="true" className="absolute -start-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <SubmitButton pending={pending} pendingText="שולחים…" className="w-full">
        שליחת הבקשה
      </SubmitButton>
    </form>
  );
}
