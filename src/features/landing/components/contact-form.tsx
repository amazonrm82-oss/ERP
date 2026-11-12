"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { TurnstileWidget } from "@/features/auth/components/turnstile-widget";
import { TURNSTILE_ACTIONS, TURNSTILE_FIELD } from "@/features/auth/turnstile";
import { CONTACT_BUSINESS_TYPES, CONTACT_CONSENT_TEXT, CONTACT_HONEYPOT_FIELD as HONEYPOT_FIELD, CONTACT_STARTED_FIELD as STARTED_AT_FIELD } from "../contact";
import styles from "./landing.module.css";

type Answer = { ok: boolean; message: string; field?: string };

/**
 * LND-20 v2 (8): "נחזור אליכם". Posts to /api/forms/contact, which checks Turnstile and hands the inquiry to the public intake of
 * Mexuz's own lead form. The consent box starts unticked (DRAFT wording, its version travels with the inquiry); a hidden
 * honeypot and the fill time catch bots. No newsletter.
 */
export function ContactForm({ siteKey, privacyHref }: { siteKey: string | null; privacyHref: string }) {
  const started = useRef(0);
  const [token, setToken] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    started.current = Date.now();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const res = await fetch("/api/forms/contact", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          full_name: form.get("name"),
          phone: form.get("phone"),
          business_type: form.get("business_type"),
          consent: form.get("consent") === "on",
          [HONEYPOT_FIELD]: form.get(HONEYPOT_FIELD) ?? "",
          [STARTED_AT_FIELD]: started.current,
          [TURNSTILE_FIELD]: token ?? form.get(TURNSTILE_FIELD) ?? "",
        }),
      });
      const body = (await res.json().catch(() => null)) as Answer | null;
      setAnswer(body && typeof body.message === "string" ? body : { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
    } catch {
      setAnswer({ ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
    } finally {
      setBusy(false);
    }
  };

  if (answer?.ok) {
    return (
      <div className={styles.form}>
        <p role="status" className={`${styles.formMsg} ${styles.formOk}`}>
          {answer.message}
        </p>
      </div>
    );
  }
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <label>
        שם מלא <input name="name" type="text" autoComplete="name" required aria-invalid={answer?.field === "full_name" || undefined} />
      </label>
      <label>
        טלפון <input name="phone" type="tel" dir="ltr" autoComplete="tel" inputMode="tel" required aria-invalid={answer?.field === "phone" || undefined} />
      </label>
      <label>
        סוג העסק
        <select name="business_type" defaultValue="">
          <option value="">בחרו</option>
          {CONTACT_BUSINESS_TYPES.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </label>
      <label className={styles.consent}>
        <input type="checkbox" name="consent" required aria-invalid={answer?.field === "consent" || undefined} />
        <span>
          {CONTACT_CONSENT_TEXT} <span className={styles.tiny}>(נוסח טיוטה, עד אישור עורך הדין)</span>
        </span>
      </label>
      <div className={styles.hp} aria-hidden="true">
        <label>
          אל תמלאו <input name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {siteKey ? <TurnstileWidget siteKey={siteKey} action={TURNSTILE_ACTIONS.contact} resetSignal={answer} onToken={setToken} /> : null}
      <button className={`${styles.btn} ${styles.primary}`} type="submit" disabled={busy}>
        שנחזור אליכם
      </button>
      {answer ? (
        <p role="alert" className={`${styles.formMsg} ${styles.formErr}`}>
          {answer.message}
        </p>
      ) : null}
      <p className={styles.tiny}>
        בלי ניוזלטר ובלי רשימות תפוצה. הפרטים משמשים רק לשיחה הזאת. <a href={privacyHref}>מדיניות פרטיות</a>
      </p>
    </form>
  );
}
