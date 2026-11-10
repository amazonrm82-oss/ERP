"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";

import { PREFERENCES_TEXTS, preferencesPagePath, unsubscribeSubmitPath, type PreferenceChannel } from "../model";

type Reply = { ok: true } | { ok: false; message: string };

/**
 * CNS-09: the confirmation a message's unsubscribe link opens. Opening the page changes nothing (a link scanner that only
 * opens links never unsubscribes anyone); the button posts the unsubscribe.
 */
export function UnsubscribeConfirm({ token, channel, full }: { token: string; channel: PreferenceChannel; full: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  async function unsubscribe() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(unsubscribeSubmitPath(token), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
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
      <div ref={doneRef} tabIndex={-1} role="status" className="space-y-3 rounded-lg border border-line bg-surface p-5 text-center outline-none">
        <span aria-hidden="true" className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-on-accent">
          <CheckIcon className="size-6" />
        </span>
        <p className="text-lead font-semibold">{PREFERENCES_TEXTS.unsubscribed}</p>
        <p className="text-md text-ink-soft">{PREFERENCES_TEXTS.unsubscribedLine}</p>
        {full ? (
          <Link href={preferencesPagePath(token)} className="inline-block text-md text-accent-strong underline underline-offset-2">
            {PREFERENCES_TEXTS.morePreferences}
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FormError message={error} />
      <p className="text-md">{PREFERENCES_TEXTS.unsubscribeIntro(channel)}</p>
      <p className="text-sm text-ink-soft">{PREFERENCES_TEXTS.unsubscribeNote}</p>
      <Button className="w-full" onClick={() => void unsubscribe()} disabled={pending}>
        {pending ? "מסירים…" : PREFERENCES_TEXTS.unsubscribeButton}
      </Button>
      {full ? (
        <p className="text-center">
          <Link href={preferencesPagePath(token)} className="text-md text-accent-strong underline underline-offset-2">
            {PREFERENCES_TEXTS.morePreferences}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
