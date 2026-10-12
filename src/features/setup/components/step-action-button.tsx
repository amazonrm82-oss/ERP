"use client";

import { useActionState, type ReactNode } from "react";

import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

type Props = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "sm";
  pendingText?: string;
};

/** One button that runs a wizard action (skip, finish, open the import) and shows its error, if any. */
export function StepActionButton({ action, children, variant = "secondary", size = "md", pendingText = "רגע…" }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(action, null);
  return (
    <form action={formAction} className="contents">
      <SubmitButton variant={variant} size={size} pendingText={pendingText}>
        {children}
      </SubmitButton>
      <FormError message={state && !state.ok ? state.message : null} className="basis-full" />
    </form>
  );
}
