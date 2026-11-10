"use client";

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";

import { IconButton } from "@/components/ui/button";
import { CloseIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/sheet";
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

function subscribeBeside(onChange: () => void) {
  const media = window.matchMedia(SIDE_PANEL_MEDIA);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const besideNow = () => window.matchMedia(SIDE_PANEL_MEDIA).matches;
// on the server the width is unknown: nothing opens until the browser knows it
const besideOnServer = () => null;

/**
 * A panel beside the page (UX-01, owner's answer 215 ב). On a computer it stands at the end of the screen (the left
 * in Hebrew) and the page stays active beside it: no dimming, a click elsewhere does not close it, and choosing
 * another row only replaces what it shows; Escape and the X close it.
 * On a phone it is THE app's bottom sheet (Sheet, the same as the bottom bar's "עוד"; owner, "גיליון אחד בטלפון",
 * 10 November 2026) at 88% of the visible screen: its body scrolls inside it, the footer stays at its bottom inside
 * the sheet, and Escape, a tap outside, the X and dragging the handle down close it.
 */
export function SidePanel({ open, onClose, title, subtitle, children, footer, className }: Props) {
  const beside = useSyncExternalStore(subscribeBeside, besideNow, besideOnServer);
  if (beside === false) {
    return (
      <Sheet open={open} onClose={onClose} title={title} subtitle={subtitle} footer={footer} height="tall" below="md" focusTitle closeLabel="סגירת הפאנל" className={className} sidePanel>
        {children}
      </Sheet>
    );
  }
  return (
    <BesidePanel open={open && beside === true} onClose={onClose} title={title} subtitle={subtitle} footer={footer} className={className}>
      {children}
    </BesidePanel>
  );
}

function BesidePanel({ open, onClose, title, subtitle, children, footer, className }: Props) {
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
    if (!dialog.open) dialog.show();
    // show() moves focus into the panel by itself; give it back to the row that opened it, so the list keeps working
    // with the keyboard
    if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
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
      onKeyDown={(event) => {
        // a dialog opened with show() gets no cancel event: Escape from inside closes it here
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          close.current();
        }
      }}
      data-side-panel=""
      className={cn(
        "fixed inset-y-0 start-auto end-0 z-40 m-0 h-dvh max-h-dvh w-[28rem] max-w-[calc(100vw-2rem)] overflow-hidden border-s border-line bg-surface p-0 text-ink shadow-xl open:flex open:flex-col",
        className,
      )}
    >
      {open ? (
        <>
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 pt-3 pb-3">
            <div className="min-w-0 pt-1.5">
              <h2 id={titleId} data-panel-title="" tabIndex={-1} className="text-lead font-semibold break-words outline-none focus:outline-none focus-visible:outline-none">
                {title}
              </h2>
              {subtitle ? <div className="mt-1 text-sm text-ink-soft">{subtitle}</div> : null}
            </div>
            <IconButton label="סגירת הפאנל" icon={<CloseIcon className="size-5" />} onClick={() => close.current()} className="-me-2" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="shrink-0 border-t border-line bg-surface px-5 py-3">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
