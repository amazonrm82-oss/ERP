"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { INSTANT_REPLY_DEFAULT_HINT, INSTANT_REPLY_DEFAULT_LABEL } from "../instant-reply";
import { saveInstantReplyDefaultAction } from "../instant-reply-actions";

/** SPD-04 (owner (259) א): the business default of the instant reply; each form keeps its own switch. */
export function InstantReplyDefaultForm({ orgId, value }: { orgId: string; value: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(saveInstantReplyDefaultAction.bind(null, orgId), null);
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={state && !state.ok ? state.message : null} />
      <Checkbox name="instant_reply_default" defaultChecked={value} label={INSTANT_REPLY_DEFAULT_LABEL} hint={INSTANT_REPLY_DEFAULT_HINT} />
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" variant="secondary" pendingText="שומרים…">
          שמירה
        </SubmitButton>
        {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
      </div>
    </form>
  );
}
