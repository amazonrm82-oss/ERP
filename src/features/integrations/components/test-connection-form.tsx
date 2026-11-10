"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { testConnectionAction } from "../actions";

/**
 * INT-01: "בדיקת חיבור" for a Meta page, with the STORED token (owner, answer (227) ב). The server reads and decrypts the
 * token itself; nothing is typed here and nothing of the token reaches the browser. 5 tests per connection in 10 minutes.
 */
export function TestConnectionForm({ orgId, integrationId }: { orgId: string; integrationId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(testConnectionAction.bind(null, orgId, integrationId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3">
      <FormError message={failure ? failure.message : null} />
      <SubmitButton variant="secondary">בדיקת החיבור</SubmitButton>
      <p className="text-sm text-ink-soft">הבדיקה נעשית עם הטוקן השמור, מול פייסבוק. אפשר לבדוק עד 5 פעמים ב-10 דקות.</p>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}
