"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import type { ActionResult } from "@/lib/action-result";

import { bookingManageSubmitPath } from "../paths";
import { confirmationFrom, type BookingConfirmation } from "../public";
import { Booked } from "./public-booking-form";

type Reply = { ok: true; cancelled?: true; confirmation?: unknown } | { ok: false; message: string; slotTaken?: boolean; tooLate?: boolean };

const OFFLINE = "אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.";

async function post(token: string, body: Record<string, unknown>): Promise<Reply> {
  try {
    const res = await fetch(bookingManageSubmitPath(token), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as Reply;
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

/** CAL-10b: cancels the meeting through the personal link, after asking; the page then shows it cancelled. */
export function BookingManageCancel({ token }: { token: string }) {
  const router = useRouter();
  async function cancel(): Promise<ActionResult> {
    const reply = await post(token, { action: "cancel" });
    return reply.ok ? { ok: true } : { ok: false, message: reply.message };
  }
  return (
    <ConfirmButton
      variant="danger"
      size="md"
      title="לבטל את הפגישה?"
      description="העסק יקבל הודעה על הביטול. אפשר לקבוע פגישה חדשה בדף קביעת התורים."
      confirmLabel="ביטול הפגישה"
      action={cancel}
      onDone={() => router.refresh()}
    >
      ביטול הפגישה
    </ConfirmButton>
  );
}

/** CAL-10b: moves the meeting to the picked time (a cancel and a new booking); shows the new confirmation. */
export function BookingManageChange({ token, startsAt, timeZone, business, backHref }: { token: string; startsAt: string; timeZone: string; business: string; backHref: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; slotTaken?: boolean } | null>(null);
  const [done, setDone] = useState<BookingConfirmation | null>(null);

  async function change() {
    setPending(true);
    setError(null);
    const reply = await post(token, { action: "change", starts_at: startsAt });
    setPending(false);
    if (!reply.ok) {
      setError({ message: reply.message, slotTaken: reply.slotTaken });
      return;
    }
    const confirmation = confirmationFrom(reply.confirmation);
    if (confirmation) setDone(confirmation);
    else setError({ message: "משהו השתבש. נסו שוב בעוד רגע." });
  }

  if (done) {
    return <Booked confirmation={done} business={business} startsAt={startsAt} timeZone={timeZone} heading="הפגישה הועברה" />;
  }
  return (
    <div className="space-y-3">
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
      <Button className="w-full" onClick={change} loading={pending} disabled={pending}>
        העברת הפגישה לזמן הזה
      </Button>
      <p className="text-sm text-ink-soft">הפגישה הקודמת תבוטל, והעסק יקבל הודעה.</p>
    </div>
  );
}
