"use client";

import { useEffect } from "react";

import { createFocusRescue, type FocusNode } from "@/lib/focus-rescue";

/**
 * FXA-08: one safety net for the whole app (the rule is in src/lib/focus-rescue.ts). When the focused control disappears
 * (a deleted row, an answered question) focus moves to the next row of its list, else the previous one, else the page's
 * main heading; a button disabled while its action ran gets focus back when it is enabled again. Renders nothing.
 */
export function FocusRescue() {
  useEffect(() => {
    const rescue = createFocusRescue({
      activeElement: () => document.activeElement as FocusNode | null,
      body: document.body as unknown as FocusNode,
    });

    function onFocusIn(event: FocusEvent) {
      if (event.target instanceof HTMLElement) rescue.focusIn(event.target as unknown as FocusNode);
    }

    const observer = new MutationObserver(() => rescue.changed());
    document.addEventListener("focusin", onFocusIn);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      observer.disconnect();
    };
  }, []);
  return null;
}
