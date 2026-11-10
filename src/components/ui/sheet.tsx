"use client";

import { useEffect, useId, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";

import { IconButton } from "@/components/ui/button";
import { CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { focusIsLost, focusLanding, setDialogLanding, type FocusLanding, type FocusNode } from "@/lib/focus-rescue";

// how tall a phone sheet opens: to its content (up to 85% of the screen), or 88% of the visible screen whatever it
// holds, its body scrolling inside (owner, "גיליון אחד בטלפון", 10 November 2026; height in globals.css)
export type SheetHeight = "content" | "tall";
// the width below which it is a sheet from the bottom edge (Tailwind's sm or md); from it up it is a centred window
export type SheetBreakpoint = "sm" | "md";

// a sheet closes when its handle is dragged down this far (px, or a quarter of the sheet when that is less),
// or flicked down at least this fast (px per ms)
export const SHEET_CLOSE_DISTANCE = 96;
export const SHEET_CLOSE_SPEED = 0.6;

/** Whether a drag of the sheet's handle ends by closing it (pure, for the unit test). */
export function sheetDragCloses(distance: number, milliseconds: number, sheetHeight: number): boolean {
  if (!(distance > 0)) return false;
  const far = sheetHeight > 0 ? Math.min(SHEET_CLOSE_DISTANCE, sheetHeight * 0.25) : SHEET_CLOSE_DISTANCE;
  if (distance >= far) return true;
  // a short, quick flick also closes it
  return distance >= 24 && milliseconds > 0 && distance / milliseconds >= SHEET_CLOSE_SPEED;
}

// Tailwind needs whole class names: the phone part of a sheet, per breakpoint (bottom edge, full width, top corners)
const PHONE_CLASSES: Record<SheetBreakpoint, string> = {
  sm: "max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]",
  md: "max-md:mb-0 max-md:w-full max-md:max-w-none max-md:rounded-b-none max-md:pb-[env(safe-area-inset-bottom)]",
};
const HANDLE_HIDDEN: Record<SheetBreakpoint, string> = { sm: "sm:hidden", md: "md:hidden" };
// under the handle the header needs less room; from the breakpoint up there is no handle
const HEADER_TOP: Record<SheetBreakpoint, string> = { sm: "pt-1 sm:pt-3", md: "pt-1 md:pt-3" };

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: string;
  // a short line under the title (a lead's phone)
  subtitle?: ReactNode;
  children?: ReactNode;
  // kept at the bottom, inside the sheet
  footer?: ReactNode;
  footerClassName?: string;
  height?: SheetHeight;
  below?: SheetBreakpoint;
  // focus the title when it opens (a panel of facts), instead of the first control or the one marked autoFocus
  focusTitle?: boolean;
  closeLabel?: string;
  className?: string;
  dialogRef?: RefObject<HTMLDialogElement | null>;
  // marks the element for the side panel's tests and styles (data-side-panel)
  sidePanel?: boolean;
};

/**
 * THE bottom sheet of the app (DSN-07, UX-01): the bottom bar's "עוד", every Dialog variant="sheet" and the side panel
 * on a phone. A modal native <dialog> from the bottom edge: the page behind is inert, it slides up (globals.css), and
 * Escape, a tap on the dimmed area, the X and dragging the handle down close it; focus goes back to what opened it.
 * From the breakpoint up it is a centred window.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  subtitle,
  children,
  footer,
  footerClassName,
  height = "content",
  below = "sm",
  focusTitle = false,
  closeLabel = "סגירה",
  className,
  dialogRef,
  sidePanel = false,
}: SheetProps) {
  const ownRef = useRef<HTMLDialogElement>(null);
  const ref = dialogRef ?? ownRef;
  const titleId = useId();
  const descriptionId = useId();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  const drag = useSheetDrag(ref, close);
  const tall = height === "tall";

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    // what had focus before the sheet opened; focus goes back there when it closes or unmounts
    // (never an element of this sheet itself: a re-run of this effect, e.g. React's development double run, finds focus on
    // the title it moved there, and a landing worked out from inside would point back at this sheet for ever)
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && !dialog.contains(active) ? active : null;
    // FXA-08: if the opener is gone by the time the sheet closes (its row was deleted), focus lands on the next row
    const landing = opener && opener !== document.body ? focusLanding(opener as unknown as FocusNode) : null;
    if (landing) setDialogLanding(dialog, landing);
    if (!dialog.open) dialog.showModal();
    // a browser without dvh: a tall sheet follows the visible window through a variable (globals.css)
    const noDvh = typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("height", "1dvh");
    const measure = () => dialog.style.setProperty("--mx-sheet-viewport", `${window.innerHeight}px`);
    if (noDvh) {
      measure();
      window.addEventListener("resize", measure);
    }
    // React's autoFocus runs while the sheet is still closed and cannot focus, and showModal picks the first
    // button (the X): move focus to the control marked autoFocus, else to the title when asked
    const marked = dialog.querySelector<HTMLElement>("[data-autofocus]");
    if (marked) marked.focus();
    else if (focusTitle) dialog.querySelector<HTMLElement>("[data-sheet-title]")?.focus();
    return () => {
      if (noDvh) window.removeEventListener("resize", measure);
      if (dialog.open) dialog.close();
      restoreFocus(opener, dialog, landing);
    };
  }, [open, ref, focusTitle]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-sheet-height={height}
      data-sheet-below={below}
      data-side-panel={sidePanel ? "" : undefined}
      onCancel={(event) => {
        // Escape: let the parent decide, so its state stays the truth
        event.preventDefault();
        close.current();
      }}
      onClick={(event) => {
        // the dimmed area around the sheet
        if (event.target === event.currentTarget) close.current();
      }}
      className={cn(
        "mx-sheet m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg rounded-lg border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-brand/60",
        tall ? "overflow-hidden open:flex open:flex-col" : "overflow-y-auto",
        PHONE_CLASSES[below],
        className,
      )}
    >
      {open ? (
        <div className={tall ? "flex min-h-0 flex-1 flex-col" : "flex flex-col"}>
          {/* the handle: drag it down to close (the X stays for keyboards and screen readers) */}
          <div
            aria-hidden="true"
            data-sheet-handle=""
            {...drag}
            className={cn("flex h-6 shrink-0 cursor-grab touch-none items-center justify-center", HANDLE_HIDDEN[below])}
          >
            <span className="h-1 w-10 rounded-full bg-line-strong" />
          </div>
          <div className={cn("flex shrink-0 items-start justify-between gap-3 px-4 sm:px-5", tall && "border-b border-line pb-3", HEADER_TOP[below])}>
            <div className="min-w-0 pt-2">
              <h2
                id={titleId}
                data-sheet-title=""
                tabIndex={focusTitle ? -1 : undefined}
                className="text-lead font-semibold break-words outline-none focus:outline-none focus-visible:outline-none"
              >
                {title}
              </h2>
              {subtitle ? <div className="mt-1 text-sm text-ink-soft">{subtitle}</div> : null}
              {description ? (
                <p id={descriptionId} className="mt-1 text-md text-ink-soft">
                  {description}
                </p>
              ) : null}
            </div>
            <IconButton label={closeLabel} icon={<CloseIcon className="size-5" />} onClick={() => close.current()} className="-me-2" />
          </div>
          {children ? <div className={tall ? "min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5" : "px-4 py-3 sm:px-5"}>{children}</div> : null}
          {/* inside the sheet, at its bottom: only the body above it scrolls */}
          {footer ? (
            <div data-sheet-footer="" className={cn("border-t border-line px-4 py-3 sm:px-5", tall && "sticky bottom-0 shrink-0 bg-surface", footerClassName)}>
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Dragging a sheet's handle down moves the sheet with the finger and closes it past the line (pointer events). */
function useSheetDrag(ref: RefObject<HTMLDialogElement | null>, close: RefObject<() => void>) {
  const drag = useRef<{ id: number; y: number; at: number; moved: number } | null>(null);
  const reset = (animate: boolean) => {
    drag.current = null;
    const dialog = ref.current;
    if (!dialog) return;
    dialog.style.transition = animate ? "transform 150ms ease-out" : "";
    dialog.style.transform = "";
  };
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!ref.current?.matches(":modal") || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { id: event.pointerId, y: event.clientY, at: event.timeStamp, moved: 0 };
      ref.current.style.transition = "none";
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || state.id !== event.pointerId || !ref.current) return;
      state.moved = Math.max(0, event.clientY - state.y);
      ref.current.style.transform = state.moved > 0 ? `translateY(${state.moved}px)` : "";
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || state.id !== event.pointerId) return;
      const closes = sheetDragCloses(state.moved, event.timeStamp - state.at, ref.current?.getBoundingClientRect().height ?? 0);
      reset(!closes);
      if (closes) close.current();
    },
    onPointerCancel: () => reset(true),
  };
}

/** Gives focus back to what opened a modal window or sheet, or, when it is gone, to the next row (FXA-08). */
export function restoreFocus(target: HTMLElement | null, dialog: HTMLDialogElement, landing: FocusLanding | null) {
  const active = document.activeElement;
  // only when focus was lost (the body, a removed element) or is still inside the closed window
  if (!focusIsLost(active as FocusNode | null, document.body as unknown as FocusNode) && !(active && dialog.contains(active))) return;
  if (target?.isConnected) {
    target.focus();
    return;
  }
  // the opener went away with its row: the next row, else the previous one, else the page's main heading
  (landing?.() as HTMLElement | null)?.focus();
}
