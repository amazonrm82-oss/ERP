"use client";

import { useEffect, type RefObject } from "react";

/**
 * Escape closes an open panel and puts focus back on the button that opened
 * it (WCAG 2.1.2 / 2.4.3). For panels that are not built on Popover or Dialog.
 */
export function useEscapeToClose(open: boolean, close: () => void, trigger?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
        trigger?.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close, trigger]);
}
