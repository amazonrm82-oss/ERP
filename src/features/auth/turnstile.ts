// Cloudflare Turnstile on the sign-in, sign-up and forgot-password forms (owner (275) א; FXS-12: with the project's secret
// key Supabase Auth skips its own CAPTCHA, so OUR server verifies the token before any Auth call; Supabase's CAPTCHA
// protection stays off). This file holds only what both sides share: no key, no secret. The secret is read only by
// ./turnstile-server.ts; the site key reaches the forms as a prop from their server pages, only while both keys are set.

/** The official script, explicit rendering (the widget is drawn by ./components/turnstile-widget.tsx). */
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The origin the script and the challenge frame come from (the CSP of the three pages names it, nothing wider). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The hidden field the widget writes its token into (Turnstile's default name). */
export const TURNSTILE_FIELD = "cf-turnstile-response";

/** The action each form's widget carries; the server accepts a token only for the same form. */
export const TURNSTILE_ACTIONS = { signIn: "login", signUp: "signup", forgotPassword: "forgot_password" } as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

/** The widget's theme from the page's own (data-theme on <html>, kept by src/features/theme): dark or light, never by the device alone. */
export function turnstileTheme(dataTheme: string | null | undefined): "dark" | "light" {
  return dataTheme === "dark" ? "dark" : "light";
}
