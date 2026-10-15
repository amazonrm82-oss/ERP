"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { FormError } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { CalendarIcon, CheckIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { collectAttribution } from "@/features/intake/attribution";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";
import { MEETING_TYPE_LABEL } from "@/features/meetings/schema";
import type { BookingQuestion } from "@/lib/database.types";
import { longDay } from "@/lib/calendar-grid";
import { zoneTime } from "@/lib/format";

import { bookingSubmitPath } from "../paths";
import { bookingIcs, localDate, type BookingConfirmation } from "../public";
import { BOOKING_ANSWER_MAX } from "../schema";

type Props = {
  token: string;
  // the business name the page shows, for the calendar file
  business: string;
  startsAt: string;
  timeZone: string;
  questions: BookingQuestion[];
  // the week view to go back to, for "choose another time"
  backHref: string;
};

type Reply = { ok: true; confirmation: BookingConfirmation | null } | { ok: false; message: string; field?: string; slotTaken?: boolean };

/** CAL-10: the booker's details and answers for one picked time; posts to /api/forms/booking/<token>. */
export function PublicBookingForm({ token, business, startsAt, timeZone, questions, backHref }: Props) {
  const [startedAt] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; slotTaken?: boolean } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<BookingConfirmation | "spam" | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "").trim();
    const wrong: Record<string, string> = {};
    if (!value("full_name")) wrong.full_name = "יש לכתוב שם.";
    if (value("phone").replace(/\D/g, "").length < 9) wrong.phone = "יש לכתוב מספר טלפון תקין.";
    for (const q of questions) {
      if (q.required && !value(`answer_${q.id}`)) wrong[`answer_${q.id}`] = "יש לענות על השאלה הזו.";
    }
    setFieldErrors(wrong);
    if (Object.keys(wrong).length > 0) {
      // the first wrong field gets focus, and with it its label and message are read out
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setPending(true);
    try {
      const res = await fetch(bookingSubmitPath(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // CAP-02: UTM, click ids, referrer and landing page, from this page's address
          ...collectAttribution(window.location.href, document.referrer),
          starts_at: startsAt,
          full_name: value("full_name"),
          phone: value("phone"),
          email: value("email"),
          answers: Object.fromEntries(questions.map((q) => [q.id, value(`answer_${q.id}`)])),
          [HONEYPOT_FIELD]: value(HONEYPOT_FIELD),
          [STARTED_AT_FIELD]: startedAt,
        }),
      });
      const reply = (await res.json()) as Reply;
      if (!reply.ok) {
        if (reply.field && reply.field !== "answers") setFieldErrors({ [reply.field]: reply.message });
        else setError({ message: reply.message, slotTaken: reply.slotTaken });
      } else {
        setDone(reply.confirmation ?? "spam");
      }
    } catch {
      setError({ message: "אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב." });
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return <Booked confirmation={done === "spam" ? null : done} business={business} startsAt={startsAt} timeZone={timeZone} />;
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error ? (
        <div className="space-y-2">
          <FormError message={error.message} />
          {error.slotTaken ? (
            <a href={backHref} className="text-sm font-medium text-accent underline underline-offset-4">
              בחירת זמן אחר
            </a>
          ) : null}
        </div>
      ) : null}
      <TextField label="שם מלא" name="full_name" required autoComplete="name" maxLength={200} error={fieldErrors.full_name} />
      <TextField label="טלפון" name="phone" type="tel" required autoComplete="tel" inputMode="tel" dir="ltr" maxLength={40} error={fieldErrors.phone} />
      <TextField label="אימייל (לא חובה)" name="email" type="email" autoComplete="email" dir="ltr" maxLength={254} error={fieldErrors.email} />
      {questions.map((q) => (
        <TextareaField
          key={q.id}
          label={q.required ? q.label : `${q.label} (לא חובה)`}
          name={`answer_${q.id}`}
          required={q.required}
          rows={2}
          maxLength={BOOKING_ANSWER_MAX}
          error={fieldErrors[`answer_${q.id}`]}
        />
      ))}
      {/* honeypot: hidden from people and from screen readers; bots fill it */}
      <div aria-hidden="true" className="absolute -start-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <SubmitButton pending={pending} pendingText="קובעים…" className="w-full">
        קביעת הפגישה
      </SubmitButton>
    </form>
  );
}

/** The confirmation on screen. Focus moves to it, so a screen reader reads it out. */
function Booked({ confirmation, business, startsAt, timeZone }: { confirmation: BookingConfirmation | null; business: string; startsAt: string; timeZone: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // one UID per confirmation, so downloading twice updates the same calendar entry
  const [uid] = useState(() => crypto.randomUUID());
  useEffect(() => ref.current?.focus(), []);
  const zone = confirmation?.timeZone ?? timeZone;
  const start = confirmation?.startsAt ?? startsAt;
  const when = `${longDay(localDate(start, zone))}, ${zoneTime(new Date(start), zone)}${confirmation ? `-${zoneTime(new Date(confirmation.endsAt), zone)}` : ""}`;
  return (
    <div ref={ref} tabIndex={-1} role="status" className="rounded-lg border border-line bg-surface p-5 text-center outline-none">
      <span aria-hidden="true" className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-accent text-on-accent">
        <CheckIcon className="size-6" />
      </span>
      <p className="text-lead font-semibold">הפגישה נקבעה</p>
      <p className="mt-2 text-md">{when}</p>
      {confirmation ? (
        <p className="mt-1 text-md text-ink-soft">
          {confirmation.meeting.name}
          {confirmation.rep ? ` עם ${confirmation.rep}` : ""} · {MEETING_TYPE_LABEL[confirmation.meeting.format] ?? ""}
          {confirmation.meeting.location ? ` · ${confirmation.meeting.location}` : ""}
        </p>
      ) : null}
      {confirmation ? (
        <Button variant="secondary" className="mt-4" onClick={() => downloadIcs(bookingIcs(confirmation, business, uid))}>
          <CalendarIcon className="size-4" aria-hidden="true" />
          הוספה ליומן
        </Button>
      ) : null}
      <p className="mt-3 text-sm text-ink-soft">כדאי לשמור את הפרטים. לשינוי או לביטול, פנו לעסק.</p>
    </div>
  );
}

/** Saves the calendar file (.ics); calendar apps on phones and computers open it to add the meeting. */
function downloadIcs(ics: string) {
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "פגישה.ics";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
