"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

import { oauthCallbackPath } from "../oauth-signup";

// Shown only once Google sign-in is set up in Supabase (Authentication -> Providers -> Google)
// and NEXT_PUBLIC_AUTH_GOOGLE=on is set in Vercel.
export const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_AUTH_GOOGLE === "on";

// WEB-02 (403) ב: on the sign-up page the price card's plan and the landing source ride in the callback's query
export function GoogleButton({ next, landingSource = null, signupPlan = null }: { next: string; landingSource?: string | null; signupPlan?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!GOOGLE_ENABLED) return null;
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const callback = `${window.location.origin}${oauthCallbackPath(next, landingSource, signupPlan)}`;
          const { error: oauthError } = await createClient().auth.signInWithOAuth({ provider: "google", options: { redirectTo: callback } });
          if (oauthError) {
            setBusy(false);
            setError("לא הצלחנו להתחבר עם Google. נסו שוב או התחברו עם אימייל וסיסמה.");
          }
        }}
      >
        {busy ? "מעבירים ל-Google…" : "כניסה עם Google"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
