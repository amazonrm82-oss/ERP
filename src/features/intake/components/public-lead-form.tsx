"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { ChatIcon, CheckIcon } from "@/components/ui/icons";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

import { collectAttribution } from "../attribution";
import { CALLBACK_INPUT, type CallbackOffer } from "../callback";
import { formInputName, HONEYPOT_FIELD, STARTED_AT_FIELD } from "../fields";
import { checkSubmission, type PublicField, type RawValues } from "../public-validate";

// whatsappUrl: CAP-05, the thank-you state's chat with the business (wa.me), or null for no button
// callback: SPD-05, what the form offered when the page was made, or null when the form does not ask
type Props = { token: string; fields: PublicField[]; submitLabel: string; whatsappUrl: string | null; callback: CallbackOffer | null };

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
export function PublicLeadForm({ token, fields, submitLabel, whatsappUrl, callback }: Props) {
  const router = useRouter();
  const [startedAt] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one message per wrong field, next to it (FXA-02)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  // SPD-05: a refused call-back choice empties the select (the offer is fetched again)
  const [callbackRound, setCallbackRound] = useState(0);
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
      if (!reply.ok && reply.field && (reply.field === CALLBACK_INPUT || fields.some((field) => formInputName(field.key) === reply.field))) {
        setFieldErrors({ [reply.field]: reply.message });
        // SPD-05: the call-back times on the page are stale (a slot ended, midnight passed):
        // fetch the current ones; what was typed stays in the fields
        if (reply.field === CALLBACK_INPUT) {
          setCallbackRound((n) => n + 1);
          router.refresh();
        }
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
    return <ThankYou message={done} whatsappUrl={whatsappUrl} />;
  }

  return (
    <form onSubmit={submit} onChange={(event) => setValues(rawValues(event.currentTarget))} className="space-y-4" noValidate>
      <FormError message={error} />
      {fields.map((field) =>
        visible.has(field.key) ? <PublicInput key={field.key} field={field} error={fieldErrors[formInputName(field.key)]} /> : null,
      )}
      {callback && (callback.now || callback.groups.length > 0) ? <CallbackChoice
          key={callbackRound}
          offer={callback}
          error={fieldErrors[CALLBACK_INPUT]}
          // the refusal stays until another time is picked
          onPick={() =>
            setFieldErrors((errors) => {
              const rest = { ...errors };
              delete rest[CALLBACK_INPUT];
              return rest;
            })
          }
        /> : null}
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

/**
 * CAP-05: the thank-you state, in the business's colour (inside BrandScope).
 * Focus moves to it, so a screen reader reads it out and a keyboard user is not
 * left on a button that is gone. A redirect URL, when set, wins before this shows.
 */
function ThankYou({ message, whatsappUrl }: { message: string; whatsappUrl: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="rounded-lg border border-line bg-surface p-5 text-center outline-none">
      <span aria-hidden="true" className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-accent text-on-accent">
        <CheckIcon className="size-6" />
      </span>
      <p className="text-lead font-semibold whitespace-pre-wrap">{message}</p>
      {whatsappUrl ? (
        <>
          <p className="mt-4 text-md text-ink-soft">רוצים להמשיך לדבר? אפשר לכתוב לנו גם ב-WhatsApp.</p>
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "md", "mt-3 w-full gap-2")}>
            <ChatIcon className="size-5" aria-hidden="true" />
            שליחת הודעה ב-WhatsApp
            <span className="sr-only"> (נפתח בחלון חדש)</span>
          </a>
        </>
      ) : null}
    </div>
  );
}

/** SPD-05: "now" (in working hours), or a slot today or on the next working day; no choice = no preference. Closed today: only the next working day. */
function CallbackChoice({ offer, error, onPick }: { offer: CallbackOffer; error?: string; onPick: () => void }) {
  return (
    // SPD-05: on a rest day the question names the next working day ("היום אנחנו סגורים. …")
    <SelectField label={offer.closedLine ?? "מתי נוח שנחזור אליכם?"} name={CALLBACK_INPUT} defaultValue="" error={error} onChange={onPick}>
      <option value="">לא משנה</option>
      {offer.now ? <option value="now">עכשיו</option> : null}
      {offer.groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value}>
              {group.label} {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </SelectField>
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
