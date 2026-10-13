"use client";

import { useEffect } from "react";

// DQL-01: a missing field on the completeness card links to the record page with ?edit=<input name>;
// the details card opens in editing mode and this puts the focus on that input.

/** Focuses the input named `field` inside the card labelled by `labelId`, once it is on the screen. */
export function useEditFocus(labelId: string, field: string | null | undefined, active: boolean) {
  useEffect(() => {
    if (!field || !active) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const card = document.querySelector(`[aria-labelledby="${labelId}"]`);
      const named = card?.querySelector<HTMLInputElement>(`[name="${CSS.escape(field)}"]`);
      // a hidden input (the contact's phones and emails) is focused through the first box of its group
      const target =
        named && named.type === "hidden"
          ? named.closest("fieldset")?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea")
          : named;
      target?.focus();
      target?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [labelId, field, active]);
}
