"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";

import { DIGEST_STOP_TEXTS, digestStopSubmitPath } from "../stop";

type Reply = { ok: true } | { ok: false; message: string };

/**
 * USR-11 / WAB-03 (owner (377) ב): the page the stop link of the daily summary opens. Opening it changes nothing (a link scanner
 * never stops anyone's summary); the button posts the stop.
 */
export function DigestStopConfirm({ token, business, stopped }: { token: string; business: string; stopped: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(stopped);
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done && !stopped) doneRef.current?.focus();
  }, [done, stopped]);

  async function stop() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(digestStopSubmitPath(token), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const reply = (await res.json()) as Reply;
      if (reply.ok) setDone(true);
      else setError(reply.message);
    } catch {
      setError(DIGEST_STOP_TEXTS.offline);
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
        <p className="text-lead font-semibold">{DIGEST_STOP_TEXTS.stopped}</p>
        <p className="text-md text-ink-soft">{DIGEST_STOP_TEXTS.stoppedLine}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-md">{DIGEST_STOP_TEXTS.intro(business)}</p>
      <FormError message={error} />
      <Button onClick={stop} disabled={pending} className="w-full sm:w-auto">
        {pending ? "מפסיקים…" : DIGEST_STOP_TEXTS.button}
      </Button>
    </div>
  );
}
