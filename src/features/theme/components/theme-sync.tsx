"use client";

import { useEffect } from "react";

import { applyThemeChoice, themeCookieLine, type ThemeChoice } from "../theme";

/**
 * USR-07: on a device that has no theme cookie yet (a new phone, cleared cookies), takes the choice from the profile,
 * keeps it in the cookie and applies it. From the next page on, the root layout renders it with no flash.
 */
export function ThemeSync({ choice }: { choice: ThemeChoice }) {
  useEffect(() => {
    document.cookie = themeCookieLine(choice);
    applyThemeChoice(choice, document.documentElement, window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, [choice]);
  return null;
}
