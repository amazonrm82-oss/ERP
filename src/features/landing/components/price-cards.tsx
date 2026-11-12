"use client";

import { useId, useRef, useState, type FormEvent, type PointerEvent } from "react";

import { formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { PlanCardData, PlanLine } from "../pricing";
import { WAITLIST_CONSENT_TEXT, WAITLIST_HONEYPOT, WAITLIST_TEXTS } from "../waitlist";
import styles from "./landing.module.css";

type Cycle = "monthly" | "annual";
const shekels = (agorot: number) => formatNumber(Math.round(agorot / 100));

/** Under the price: the billing, and with annual billing the year's payment, in the plan's own unit. */
function priceNote(plan: PlanCardData, cycle: Cycle): string {
  return cycle === "monthly" ? "בתשלום חודשי" : `בתשלום שנתי: ${shekels(plan.annualYearAgorot)} ₪ ${plan.unit.year}`;
}

function Line({ line }: { line: PlanLine }) {
  if (line.intro) return <li className={styles.intro}>{line.label}</li>;
  return (
    <li>
      {line.label}
      {line.soon ? <em className={styles.soon}>בקרוב</em> : null}
    </li>
  );
}

/** LND-13: "תודיעו לי כשנפתח" (email, an unticked consent with its DRAFT wording, a honeypot); POST /api/forms/plan-notify. */
function NotifyForm({ planKey, planName }: { planKey: string; planName: string }) {
  const id = useId();
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const res = await fetch("/api/forms/plan-notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          plan: planKey,
          consent: form.get("consent") === "on",
          [WAITLIST_HONEYPOT]: form.get(WAITLIST_HONEYPOT) ?? "",
        }),
      });
      const answer = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      setState({ ok: Boolean(answer?.ok), message: answer?.message ?? WAITLIST_TEXTS.error });
    } catch {
      setState({ ok: false, message: WAITLIST_TEXTS.error });
    } finally {
      setBusy(false);
    }
  };
  if (state?.ok) {
    return (
      <p role="status" className={`${styles.formMsg} ${styles.formOk}`}>
        {state.message}
      </p>
    );
  }
  return (
    <form className={styles.notify} onSubmit={submit} noValidate>
      <label htmlFor={`${id}-email`}>האימייל שלכם, ונודיע כשחבילת {planName} נפתחת</label>
      <input id={`${id}-email`} name="email" type="email" dir="ltr" autoComplete="email" required />
      <label className={styles.consent}>
        <input type="checkbox" name="consent" required />
        <span>
          {WAITLIST_CONSENT_TEXT} <span className={styles.tiny}>(נוסח טיוטה)</span>
        </span>
      </label>
      <div className={styles.hp} aria-hidden="true">
        <label>
          אל תמלאו <input name={WAITLIST_HONEYPOT} tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <button type="submit" className={`${styles.btn} ${styles.ghost}`} disabled={busy}>
        תודיעו לי כשנפתח
      </button>
      {state ? (
        <p role="alert" className={`${styles.formMsg} ${styles.formErr}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function Card({ plan, cycle }: { plan: PlanCardData; cycle: Cycle }) {
  const [flipped, setFlipped] = useState(false);
  const [notify, setNotify] = useState(false);
  const backId = useId();
  const openRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const titleId = `plan-${plan.key}`;
  const price = cycle === "monthly" ? plan.monthlyAgorot : plan.annualAgorot;
  const turn = (to: boolean) => {
    setFlipped(to);
    window.setTimeout(() => (to ? backRef : openRef).current?.focus(), 60);
  };
  // the prototype: a mouse turns the card on hover; a touch screen and the keyboard use the button
  const hover = (to: boolean) => (event: PointerEvent) => {
    if (event.pointerType === "mouse" && !notify && window.matchMedia("(hover: hover)").matches) setFlipped(to);
  };
  return (
    <li aria-labelledby={titleId} className={`${styles.plan} ${plan.highlighted ? styles.rec : ""}`} data-flipped={String(flipped)} onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
      {plan.highlighted && !plan.soon ? <span className={styles.badge}>מומלצת</span> : null}
      {plan.soon ? <span className={`${styles.badge} ${styles.badgeSoon}`}>בקרוב</span> : null}
      <div className={`${styles.face}`} inert={flipped ? true : undefined}>
        <h3 id={titleId} className={styles.planName}>
          {plan.name}
        </h3>
        <div className={styles.price}>
          <b className="text-ln-price">{shekels(price)}</b>
          <span>₪ {plan.unit.month}</span>
        </div>
        <p className={styles.priceNote}>{priceNote(plan, cycle)}</p>
        {plan.sentence ? <p className={styles.oneliner}>{plan.sentence}</p> : null}
        {notify ? (
          <NotifyForm planKey={plan.key} planName={plan.name} />
        ) : (
          <ul className={styles.hl}>
            {plan.highlights.map((line) => (
              <Line key={line.label} line={line} />
            ))}
          </ul>
        )}
        <div className={styles.faceActions}>
          <button ref={openRef} type="button" className={styles.flipbtn} aria-expanded={flipped} aria-controls={backId} onClick={() => turn(true)}>
            מה כלול? ←
          </button>
          {plan.soon ? (
            notify ? null : (
              <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={() => setNotify(true)}>
                תודיעו לי כשנפתח
              </button>
            )
          ) : (
            <a href={paths.signup} className={`${styles.btn} ${plan.highlighted ? styles.primary : styles.ghost}`}>
              {plan.highlighted ? "הרשמה לתקופת ניסיון" : "הרשמה"}
              <span className="sr-only"> לחבילה {plan.name}</span>
            </a>
          )}
        </div>
      </div>
      <div id={backId} className={`${styles.face} ${styles.back}`} inert={flipped ? undefined : true}>
        <h3 className={styles.planName}>{plan.name} · הכול</h3>
        <p className={styles.priceNote}>
          {shekels(price)} ₪ {plan.unit.month} · {priceNote(plan, cycle)}
        </p>
        <ul className={styles.full} tabIndex={0} aria-label={`מה כלול בחבילה ${plan.name}`}>
          {plan.full.map((line) => (
            <Line key={line.label} line={line} />
          ))}
        </ul>
        <button ref={backRef} type="button" className={styles.flipbtn} onClick={() => turn(false)}>
          → חזרה
        </button>
      </div>
    </li>
  );
}

/** LND-20 v2 (6): the monthly/annual switch (both prices from the plans table, owner (338) ב) and the four flip cards. */
export function PriceCards({ cards }: { cards: PlanCardData[] }) {
  const [cycle, setCycle] = useState<Cycle>("monthly");
  return (
    <>
      <div className={styles.toggle} role="group" aria-label="תקופת חיוב">
        <button type="button" aria-pressed={cycle === "monthly"} onClick={() => setCycle("monthly")}>
          חודשי
        </button>
        <button type="button" aria-pressed={cycle === "annual"} onClick={() => setCycle("annual")}>
          שנתי
        </button>
      </div>
      <ul className={styles.plans}>
        {cards.map((plan) => (
          <Card key={plan.key} plan={plan} cycle={cycle} />
        ))}
      </ul>
    </>
  );
}
