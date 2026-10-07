"use client";

// The browser offers installation once, early, through `beforeinstallprompt`
// (Chrome and Edge, on Android and desktop). The event is kept here so the
// "install the app" button can use it whenever the user opens the menu.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

let started = false;
/** Called once from the root layout, before the menu ever renders. */
export function listenForInstallPrompt() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // we show our own button instead of the browser's mini bar
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function subscribeInstallPrompt(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const canPromptInstall = () => deferred !== null;

/** Shows the browser's install dialog. true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null; // the event can be used only once
  notify();
  await event.prompt();
  return (await event.userChoice).outcome === "accepted";
}

/** Already running as an installed app (home screen / its own window). */
export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone and iPad have no install prompt: the user adds the app from the share menu. */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}
