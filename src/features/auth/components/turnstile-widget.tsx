"use client";

import { useEffect, useRef, useState } from "react";

import { TURNSTILE_FIELD, TURNSTILE_SCRIPT_URL, turnstileTheme, type TurnstileAction } from "../turnstile";

// Cloudflare Turnstile on the sign-in, sign-up and forgot-password forms (owner (275) א). Rendered only when the form's server
// page passed a site key (both keys set); the official script, explicit rendering, Managed mode (the widget's own setting),
// Hebrew, the page's theme. The token goes into the hidden field `cf-turnstile-response` inside the form, so it is posted
// with it; the server checks it (../turnstile-server.ts) before any Auth call. A token is single use, so the widget is reset
// after every answer of the form (`resetSignal`).

type RenderOptions = {
  sitekey: string;
  action: string;
  theme: "light" | "dark";
  language: string;
  size: "flexible";
  "response-field-name": string;
  "refresh-expired": "auto";
  "error-callback": () => void;
  callback: () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: RenderOptions) => string | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

// Added by the app's own (nonce-trusted) code, so the page's 'strict-dynamic' policy lets it run; the challenge frame is
// allowed by the page's frame-src (src/lib/csp.ts).
function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    script.onerror = () => {
      scriptPromise = null;
      script.remove();
      reject(new Error("turnstile script failed"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function TurnstileWidget({ siteKey, action, resetSignal }: { siteKey: string; action: TurnstileAction; resetSignal?: unknown }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then((api) => {
        if (cancelled || !container.current || widgetId.current) return;
        widgetId.current =
          api.render(container.current, {
            sitekey: siteKey,
            action,
            theme: turnstileTheme(document.documentElement.getAttribute("data-theme")),
            language: "he",
            size: "flexible",
            "response-field-name": TURNSTILE_FIELD,
            "refresh-expired": "auto",
            callback: () => setFailed(false),
            "error-callback": () => setFailed(true),
          }) ?? null;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, action]);

  // a fresh token after every answer of the form (the last one was used)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }, [resetSignal]);

  return (
    <div>
      <div ref={container} className="min-h-16" />
      {failed ? (
        <p role="alert" className="mt-1 text-sm text-danger">
          בדיקת האבטחה לא נטענה. בדקו את החיבור ורעננו את הדף.
        </p>
      ) : null}
    </div>
  );
}
