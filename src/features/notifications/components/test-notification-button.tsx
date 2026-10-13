"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";

import { sendTestNotificationAction } from "../actions";

/** GAP-01: "send me a test notification" – to the signed-in user only. */
export function TestNotificationButton({ orgId }: { orgId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function send() {
    setResult(null);
    startTransition(async () => {
      const answer = await sendTestNotificationAction(orgId);
      setResult({ ok: answer.ok, message: answer.message ?? "" });
    });
  }

  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" onClick={send} loading={pending}>
        {pending ? "שולחים…" : "שליחת התראת בדיקה אליי"}
      </Button>
      {result ? result.ok ? <FormNotice message={result.message} /> : <FormError message={result.message} /> : null}
    </div>
  );
}
