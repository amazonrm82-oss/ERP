"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { acceptInvitationAction } from "../actions";

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(acceptInvitationAction.bind(null, token), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4">
      <FormError message={failure?.message} />
      <SubmitButton pendingText="מצטרפים…" className="w-full">
        הצטרפות לעסק
      </SubmitButton>
    </form>
  );
}
