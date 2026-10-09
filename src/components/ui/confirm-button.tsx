"use client";

import { useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import type { ActionResult } from "@/lib/action-result";

type Props = {
  // the button that opens the question
  children: ReactNode;
  variant?: "danger" | "danger-ghost" | "secondary" | "primary";
  size?: "md" | "sm";
  // the question, a sentence that says what will happen
  title: string;
  description?: string;
  confirmLabel: string;
  // a bound Server Action; when it redirects, the dialog never needs to close
  action: () => Promise<ActionResult>;
  onDone?: () => void;
  disabled?: boolean;
};

/**
 * The one way to ask "are you sure?" (FXU-14). Focus starts on "ביטול", the
 * safe choice; an error stays in the window so the user can try again.
 */
export function ConfirmButton({ children, variant = "danger-ghost", size = "sm", title, description, confirmLabel, action, onDone, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      onDone?.();
    });
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} disabled={disabled}>
        {children}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        title={title}
        description={description}
        footer={
          <>
            <Button variant="secondary" autoFocus onClick={() => setOpen(false)} disabled={pending}>
              ביטול
            </Button>
            <Button variant={variant === "danger" || variant === "danger-ghost" ? "danger" : "primary"} onClick={confirm} loading={pending}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {error ? <FormError message={error} /> : null}
      </Dialog>
    </>
  );
}
