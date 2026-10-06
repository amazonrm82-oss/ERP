"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

type Props = Omit<ComponentProps<typeof Button>, "type"> & {
  // text shown while the form is being submitted
  pendingText?: string;
  // for forms that track their own pending state (useTransition)
  pending?: boolean;
};

/** Submit button that disables itself and changes its text while the form action runs. */
export function SubmitButton({ children, pendingText = "שומר…", pending, disabled, ...props }: Props) {
  const status = useFormStatus();
  const isPending = pending ?? status.pending;
  return (
    <Button type="submit" disabled={disabled || isPending} aria-busy={isPending || undefined} {...props}>
      {isPending ? pendingText : children}
    </Button>
  );
}
