"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

type PopoverProps = {
  // the button's content; it gets aria-expanded and aria-controls
  trigger: ReactNode;
  // the accessible name of the trigger when it is only an icon
  triggerLabel?: string;
  triggerClassName?: string;
  // the panel's name for screen readers
  label: string;
  // which edge of the trigger the panel lines up with on a computer
  align?: "start" | "end";
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
};

/**
 * A panel that opens under a button (bell, filters, columns). On a phone it is
 * pinned to both sides of the screen, so it never runs off the edge (FXA-01).
 * Escape and a click outside close it; focus goes back to the button.
 */
export function Popover({ trigger, triggerLabel, triggerClassName, label, align = "end", children, className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // from inside the panel, or from the button itself
        buttonRef.current?.focus();
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // when the panel closes with focus inside it, focus goes back to the button
  const wasOpen = useRef(false);
  useEffect(() => {
    const active = document.activeElement;
    // the panel's content is gone by now, so its focused element left focus on the body
    if (wasOpen.current && !open && (active === document.body || rootRef.current?.contains(active))) {
      buttonRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={triggerLabel}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      <div
        id={panelId}
        role="dialog"
        aria-label={label}
        hidden={!open}
        className={cn(
          "z-40 rounded-lg border border-line bg-surface text-ink shadow-lg",
          // phone: pinned to the screen edges, under the top bar, scrolling inside
          "max-sm:fixed max-sm:inset-x-2 max-sm:top-16 max-sm:max-h-[calc(100dvh-10rem)] max-sm:overflow-y-auto",
          // computer: under the button
          "sm:absolute sm:top-full sm:mt-2 sm:w-80 sm:max-h-[70dvh] sm:overflow-y-auto",
          align === "end" ? "sm:end-0" : "sm:start-0",
          className,
        )}
      >
        {open ? (typeof children === "function" ? children(close) : children) : null}
      </div>
    </div>
  );
}
