"use client";

import { useEffect } from "react";

import { listenForInstallPrompt } from "@/lib/install-prompt";

/**
 * Registers the service worker on every page, so the app can be installed and
 * shows the offline page instead of the browser's error. Not in development:
 * there it would serve the offline page while the dev server restarts.
 */
export function ServiceWorker() {
  useEffect(() => {
    listenForInstallPrompt();
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // not fatal: the app works without it
    });
  }, []);
  return null;
}
