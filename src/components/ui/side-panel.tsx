"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { IconButton } from "@/components/ui/button";
import { CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

// the width from which the panel stands beside the page instead of covering it (Tailwind's md)
export const SIDE_PANEL_MEDIA = "(min-width: 768px)";

type Props = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  // a short line under the title
  subtitle?: ReactNode;
  children: ReactNode;
  // kept in sight at the bottom while the body scrolls
  footer?: ReactNode;
  className?: string;
};

/**
 * A panel beside the page (UX-01, owner's answer 215 ב). On a computer it stands at the end of the screen (the left
 * in Hebrew) and the page stays active beside it: no dimming, a click elsewhere does not close it, and choosing
 * another row only replaces what it shows. On a phone it is a bottom sheet that covers the page (a modal <dialog>:
 * focus stays inside, the page behind is inert). Escape and the X close it; focus goes back to what opened it.
 */
export function SidePanel({ open, onClose, title, subtitle, children, footer, className }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const beside = window.matchMedia(SIDE_PANEL_MEDIA).matches;
    if (!dialog.open) {
      if (beside) dialog.show();
      else dialog.showModal();
    }
    // a phone's sheet takes focus (showModal picks its first control: move it to the title); beside the page,
    // focus stays where the person clicked so the list keeps working with the keyboard
    if (!beside) dialog.querySelector<HTMLElement>("[data-panel-title]")?.focus();
    // show() moves focus into the panel by itself; beside the page, give it back to the row that opened it
    else if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      const active = document.activeElement;
      if ((active === document.body || (active && dialog.contains(active))) && opener?.isConnected) opener.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onKeyDown={(event) => {
        // a dialog opened with show() gets no cancel event: Escape from inside closes it here
        if (event.key === "Escape" && !event.defaultPrevented && !ref.current?.matches(":modal")) {
          event.preventDefault();
          close.current();
        }
      }}
      onClick={(event) => {
        // the dimmed area around a phone's sheet
        if (event.target === event.currentTarget && ref.current?.matches(":modal")) close.current();
      }}
      data-side-panel=""
      className={cn(
        "m-0 overflow-hidden border-line bg-surface p-0 text-ink open:flex open:flex-col",
        // phone: a sheet from the bottom, the page dimmed behind it
        "mx-sheet max-md:mx-auto max-md:mt-auto max-md:max-h-[85dvh] max-md:w-full max-md:max-w-none max-md:rounded-t-lg max-md:border-t max-md:pb-[env(safe-area-inset-bottom)] backdrop:bg-brand/60",
        // computer: full height at the end of the screen, beside the page
        "md:fixed md:inset-y-0 md:start-auto md:end-0 md:z-40 md:h-dvh md:max-h-dvh md:w-[28rem] md:max-w-[calc(100vw-2rem)] md:border-s md:shadow-xl",
        className,
      )}
    >
      {open ? (
        <>
          <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong md:hidden" />
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 pt-3 pb-3 sm:px-5">
            <div className="min-w-0 pt-1.5">
              <h2 id={titleId} data-panel-title="" tabIndex={-1} className="text-lead font-semibold break-words outline-none focus:outline-none focus-visible:outline-none">
                {title}
              </h2>
              {subtitle ? <div className="mt-1 text-sm text-ink-soft">{subtitle}</div> : null}
            </div>
            <IconButton label="סגירת הפאנל" icon={<CloseIcon className="size-5" />} onClick={() => close.current()} className="-me-2" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
          {footer ? <div className="shrink-0 border-t border-line bg-surface px-4 py-3 sm:px-5">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
