"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { IconButton } from "@/components/ui/button";
import { CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  // the buttons at the bottom
  footer?: ReactNode;
  // "sheet": slides up from the bottom of a phone screen; a centred window from sm up
  variant?: "dialog" | "sheet";
  className?: string;
};

/**
 * A modal window on the native <dialog>: the browser keeps focus inside it,
 * Escape closes it, the page behind it is inert, and focus goes back to the
 * button that opened it. Clicking the dimmed area outside closes it too.
 */
export function Dialog({ open, onClose, title, description, children, footer, variant = "dialog", className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Escape: let the parent decide, so its state stays the truth
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-brand/60",
        variant === "sheet" && "max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
      {open ? (
        <div className="flex flex-col">
          {variant === "sheet" ? <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong sm:hidden" /> : null}
          <div className="flex items-start justify-between gap-3 px-4 pt-3 sm:px-5">
            <div className="min-w-0 pt-2">
              <h2 id={titleId} className="text-lead font-semibold">
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="mt-1 text-md text-ink-soft">
                  {description}
                </p>
              ) : null}
            </div>
            <IconButton label="סגירה" icon={<CloseIcon className="size-5" />} onClick={onClose} className="-me-2" />
          </div>
          {children ? <div className="px-4 py-3 sm:px-5">{children}</div> : null}
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 sm:px-5">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
