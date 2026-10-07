"use client";

import { useState, useTransition, type ReactNode } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

type Props = {
  // a Server Action bound to its target
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  children: ReactNode;
  className?: string;
};

/**
 * A form for the admin panel. Submits without React's form action, so the
 * fields keep what was typed when the server says no.
 */
export function PlatformForm({ action, submitLabel, children, className }: Props) {
  const [state, setState] = useState<FormState>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className={className ?? "space-y-4"}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(async () => setState(await action(state, formData)));
      }}
    >
      {children}
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
    </form>
  );
}
