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
};

/**
 * A public page that may be framed by customers' sites: every /f/ page except the QR scan route, whose page before an
 * external link (BIZ-03) carries the business's name on our domain and must never sit inside another site.
 */
export function isEmbeddablePublicPath(pathname: string): boolean {
  return pathname.startsWith("/f/") && !pathname.startsWith("/f/q/");
}

export function contentSecurityPolicy({ nonce, supabaseUrl, isDev, publicForm }: Options): string {
  const supabase = supabaseUrl ? new URL(supabaseUrl) : null;
  const connect = ["'self'"];
  if (supabase) {
    connect.push(supabase.origin, `${supabase.protocol === "https:" ? "wss" : "ws"}://${supabase.host}`);
  }
  // after a sign-in form, the browser may follow redirects to Supabase Auth and Google
  const formAction = publicForm ? ["'self'", "https:"] : ["'self'", ...(supabase ? [supabase.origin] : []), "https://accounts.google.com"];
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // file thumbnails are signed links to Supabase Storage
    `img-src 'self' blob: data:${supabase ? ` ${supabase.origin}` : ""}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
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
