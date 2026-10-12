"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";

import { Button, IconButton } from "@/components/ui/button";
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
 * REC-11: when it holds a form with unsaved changes (a FormGuard marks it), Escape,
 * the X and a click outside ask first; a form's own "ביטול" button still closes at once.
 */
export function Dialog({ onClose, ...props }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [asking, setAsking] = useState(false);

  function requestClose() {
    if (ref.current?.querySelector("form[data-unsaved]")) {
      setAsking(true);
    } else {
      onClose();
    }
  }

  return (
    <>
      <DialogFrame {...props} onClose={requestClose} dialogRef={ref} />
      {/* a sibling, not a child: the newest modal window is the one on top. Mounted only while asking. */}
      {props.open && asking ? (
        <LeaveDialog
          onStay={() => setAsking(false)}
          onLeave={() => {
            // both windows go in one commit; each gives focus back to what opened it, so it ends on
            // the button that opened this window
            setAsking(false);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * "Leave without saving?" (REC-11), open while mounted. Focus starts on staying, the safe choice;
 * render it only while asking, so a list of forms does not carry a closed <dialog> per row.
 */
export function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return (
    <DialogFrame
      open
      onClose={onStay}
      title="יש שינויים שלא נשמרו"
      description="לצאת בלי לשמור? השינויים יימחקו."
      footer={
        <>
          <Button variant="secondary" autoFocus onClick={onStay}>
            להישאר
          </Button>
          <Button variant="danger" onClick={onLeave}>
            לצאת בלי לשמור
          </Button>
        </>
      }
    />
  );
}

function DialogFrame({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = "dialog",
  className,
  dialogRef,
}: DialogProps & { dialogRef?: RefObject<HTMLDialogElement | null> }) {
  const ownRef = useRef<HTMLDialogElement>(null);
  const ref = dialogRef ?? ownRef;
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    // what had focus before the window opened; focus goes back there when it closes or unmounts
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // React's autoFocus runs while the window is still closed and cannot focus, and showModal picks the
    // first button (the X): move focus to the button marked autoFocus ("ביטול", "להישאר")
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (dialog.open) dialog.close();
      restoreFocus(opener, dialog);
    };
  }, [open, ref]);

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
        variant === "sheet" && "mx-sheet max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]",
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

function restoreFocus(target: HTMLElement | null, dialog: HTMLDialogElement) {
  if (!target?.isConnected) return;
  const active = document.activeElement;
  // only when focus was lost (the body, a removed element) or is still inside the closed window
  if (!active || active === document.body || !active.isConnected || dialog.contains(active)) target.focus();
}
