// USR-07 (owner, 18 October 2026): "לפי המכשיר" by default, or light / dark picked in the profile.
// The choice is kept in profiles.theme (null = by the device) and copied into a cookie per device, so the root layout
// renders the right theme on the first paint. By-the-device is settled before paint by THEME_SCRIPT, which the root
// layout puts in <head> (with the page's CSP nonce) and which follows the device when it changes.

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: "לפי המכשיר",
  light: "בהיר",
  dark: "כהה",
};

/** The cookie that carries the choice on this device (not a secret; a year). */
export const THEME_COOKIE = "mx-theme";
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** A cookie value, or anything else, as a choice: unknown or missing = by the device. */
export function parseThemeChoice(value: string | null | undefined): ThemeChoice {
  return isThemeChoice(value) ? value : "system";
}

/** profiles.theme to a choice (null = by the device), and back. */
export function choiceFromProfile(theme: string | null | undefined): ThemeChoice {
  return theme === "light" || theme === "dark" ? theme : "system";
}
export function profileFromChoice(choice: ThemeChoice): "light" | "dark" | null {
  return choice === "system" ? null : choice;
}

/** The data-theme the server can already set: the person's own pick; by the device is left to THEME_SCRIPT. */
export function serverThemeAttribute(choice: ThemeChoice): "light" | "dark" | undefined {
  return choice === "system" ? undefined : choice;
}

/**
 * Runs in <head> before the page paints. While <html data-theme-choice="system">, it sets data-theme="dark" when the
 * device prefers dark (and removes it otherwise), now and whenever the device changes. A picked theme is left alone.
 */
export const THEME_SCRIPT =
  "(function(){try{var d=document.documentElement,m=window.matchMedia('(prefers-color-scheme: dark)');" +
  "var a=function(){if(d.getAttribute('data-theme-choice')!=='system')return;" +
  "if(m.matches)d.setAttribute('data-theme','dark');else d.removeAttribute('data-theme');};" +
  "a();if(m.addEventListener)m.addEventListener('change',a);}catch(e){}})();";

/** Applies a choice on this page now (the profile form and a new device's first visit), the same rule as THEME_SCRIPT. */
export function applyThemeChoice(choice: ThemeChoice, root: { setAttribute(n: string, v: string): void; removeAttribute(n: string): void }, prefersDark: boolean): void {
  root.setAttribute("data-theme-choice", choice);
  const dark = choice === "dark" || (choice === "system" && prefersDark);
  if (dark) root.setAttribute("data-theme", "dark");
  else if (choice === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}

/** The cookie line for document.cookie. */
export function themeCookieLine(choice: ThemeChoice): string {
  return `${THEME_COOKIE}=${choice}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
}

/** The nonce of the page's Content-Security-Policy (FXS-05), for the inline theme script. */
export function cspNonce(policy: string | null): string | undefined {
  const match = policy?.match(/'nonce-([A-Za-z0-9+/=_-]+)'/);
  return match ? match[1] : undefined;
}

/**
 * Customer-facing pages stay light until the owner decides otherwise (review of USR-07, 19 October 2026): the landing
 * page and every /f/* page (forms, embedded forms and widgets, booking, quotes, cards). The person's choice is about
 * their own app, so neither the cookie nor the device applies there.
 */
export function isAlwaysLightPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === "/" || pathname === "/f" || pathname.startsWith("/f/");
}

/** The request header the proxy sets with the page's path, so the root layout can tell a customer page. */
export const PATH_HEADER = "x-crm-path";

/** The theme a page renders with: always light on a customer page, else the person's choice. */
export function pageThemeChoice(pathname: string | null | undefined, cookieValue: string | null | undefined): ThemeChoice {
  return isAlwaysLightPath(pathname) ? "light" : parseThemeChoice(cookieValue);
}
