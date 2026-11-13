// Content Security Policy (FXS-05). Scripts run only from this site and only
// with the nonce the proxy makes for each page view ('strict-dynamic' lets
// those scripts load the app's chunks). Styles may be inline: React writes
// style attributes, and a style cannot run code. The page connects only to
// this site and to Supabase (REST, Auth, Storage, Realtime over wss).

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

type Options = {
  nonce: string;
  // the Supabase project's URL (https://<ref>.supabase.co, or http://127.0.0.1:54321 locally)
  supabaseUrl: string | null;
  // React's development build evaluates code to rebuild error stacks
  isDev: boolean;
  // the public lead form: posts back here, then may redirect to the customer's site
  publicForm: boolean;
  // owner (275) א: while the Turnstile site key is set, every page but the customer pages under /f/ (turnstileAllowed in
  // src/lib/supabase/proxy.ts): the widget's script and challenge frame come from TURNSTILE_ORIGIN, and a client-side move
  // into the sign-in, sign-up or forgot-password page keeps the policy of the first page loaded
  turnstile?: boolean;
};

/** Cloudflare Turnstile's origin (= TURNSTILE_ORIGIN in src/features/auth/turnstile.ts; a unit test keeps them equal). */
export const CSP_TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * A public page that may be framed by customers' sites: every /f/ page except the QR scan route, whose page before an
 * external link (BIZ-03) carries the business's name on our domain and must never sit inside another site, and the
 * customer's statement page (BAL-04), which shows a customer's debts and must never sit inside another site either, and
 * the signing page (SGN-02), where a signature must never be clicked inside another site. next.config.ts leaves the same
 * prefixes out of `frame-ancestors *`; keep the two in step.
 */
// CNS-09 / CNS-10: the customer's preferences page and unsubscribe confirmation change what the person receives, so they
// never sit inside another site either (SGN-02's signing page too) (a framed button could be clicked without the person seeing it).
// LIB-02: a library item sent by a tracked link counts a view and tells the rep, so it never sits inside another site either.
export const NOT_EMBEDDABLE_PUBLIC_PREFIXES = ["/f/q/", "/f/statement/", "/f/prefs/", "/f/unsub/", "/f/sign/", "/f/lib/", "/f/fill/"] as const;

export function isEmbeddablePublicPath(pathname: string): boolean {
  return pathname.startsWith("/f/") && !NOT_EMBEDDABLE_PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function contentSecurityPolicy({ nonce, supabaseUrl, isDev, publicForm, turnstile = false }: Options): string {
  const supabase = supabaseUrl ? new URL(supabaseUrl) : null;
  const connect = ["'self'"];
  if (supabase) {
    connect.push(supabase.origin, `${supabase.protocol === "https:" ? "wss" : "ws"}://${supabase.host}`);
  }
  // after a sign-in form, the browser may follow redirects to Supabase Auth and Google
  const formAction = publicForm ? ["'self'", "https:"] : ["'self'", ...(supabase ? [supabase.origin] : []), "https://accounts.google.com"];
  const directives = [
    "default-src 'self'",
    // the Turnstile origin is for browsers without 'strict-dynamic' (CSP2); newer ones trust the script because the app's own
    // nonce-trusted code adds it
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${turnstile ? ` ${CSP_TURNSTILE_ORIGIN}` : ""}${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // file thumbnails are signed links to Supabase Storage
    `img-src 'self' blob: data:${supabase ? ` ${supabase.origin}` : ""}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    ...(turnstile ? [`frame-src 'self' ${CSP_TURNSTILE_ORIGIN}`] : []),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${formAction.join(" ")}`,
    // this header replaces the one in next.config, so framing is set here too:
    // the public form is made to be embedded in customers' sites, the app never
    `frame-ancestors ${publicForm ? "*" : "'none'"}`,
  ];
  if (!isDev) {
    directives.push("upgrade-insecure-requests");
  }
  return directives.join("; ");
}
