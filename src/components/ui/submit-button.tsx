"use client";

import { useEffect, useRef, type ComponentProps } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

type Props = Omit<ComponentProps<typeof Button>, "type"> & {
  // text shown while the form is being submitted
  pendingText?: string;
  // for forms that track their own pending state (useTransition)
  pending?: boolean;
};

/**
 * Submit button that disables itself and changes its text while the form action runs.
 * When a submit ends with fields marked wrong, focus moves to the first of them,
 * so a screen reader reads its label and its error (FXA-03); every form that
 * uses this button gets it.
 */
export function SubmitButton({ children, pendingText = "שומר…", pending, disabled, ...props }: Props) {
  const status = useFormStatus();
  const isPending = pending ?? status.pending;
  const ref = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !isPending) {
      // a frame later: the errors of the answer are on the screen by then
      const frame = requestAnimationFrame(() => {
        const form = ref.current?.form;
        form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      wasPending.current = false;
      return () => cancelAnimationFrame(frame);
    }
    wasPending.current = isPending;
  }, [isPending]);

  return (
    <Button ref={ref} type="submit" disabled={disabled || isPending} aria-busy={isPending || undefined} {...props}>
      {isPending ? pendingText : children}
    </Button>
  );
}
