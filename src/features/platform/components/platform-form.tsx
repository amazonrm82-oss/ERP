"use client";

import { useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { changesAnnouncement } from "../subprocessors";

/**
 * ADM-01: a save that sends notices to business owners asks first, naming how many. `always` = every save announces
 * (a new entry); otherwise a save announces when one of `fields` differs from `baseline` (whitespace collapsed).
 */
export type Announce = {
  audience: number;
  always?: boolean;
  baseline?: Record<string, string>;
  fields?: readonly string[];
  title: string;
  confirmLabel: string;
};

type Props = {
  // a Server Action bound to its target
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  children: ReactNode;
  className?: string;
  announce?: Announce;
};

function audienceText(count: number): string {
  if (count === 0) return "כרגע אין בעלי עסקים פעילים, ולכן לא תישלח אף הודעה.";
  if (count === 1) return "הודעה אחת תישלח לבעל עסק אחד.";
  return `${count.toLocaleString("he-IL")} הודעות יישלחו: אחת לכל בעל עסק פעיל, בכל עסק שבבעלותו. אי אפשר לבטל אותן אחרי השליחה.`;
}

/**
 * A form for the admin panel. Submits without React's form action, so the
 * fields keep what was typed when the server says no.
 */
export function PlatformForm({ action, submitLabel, children, className, announce }: Props) {
  const [state, setState] = useState<FormState>(null);
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState<FormData | null>(null);

  function send(formData: FormData) {
    startTransition(async () => {
      const next = await action(state, formData);
      setState(next);
      setAsking(null);
    });
  }

  return (
    <form
      className={className ?? "space-y-4"}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        if (announce) {
          const values = Object.fromEntries([...formData.entries()].map(([key, value]) => [key, typeof value === "string" ? value : ""]));
          if (announce.always || changesAnnouncement(announce.baseline ?? {}, values, announce.fields ?? [])) {
            setAsking(formData);
            return;
          }
        }
        send(formData);
      }}
    >
      {children}
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton pending={pending && !asking}>{submitLabel}</SubmitButton>
      {announce ? (
        <Dialog
          open={asking !== null}
          onClose={() => {
            if (!pending) setAsking(null);
          }}
          title={announce.title}
          description={audienceText(announce.audience)}
          footer={
            <>
              <Button variant="secondary" autoFocus onClick={() => setAsking(null)} disabled={pending}>
                ביטול
              </Button>
              <Button variant="primary" onClick={() => asking && send(asking)} loading={pending}>
                {announce.confirmLabel}
              </Button>
            </>
          }
        />
      ) : null}
    </form>
  );
}
