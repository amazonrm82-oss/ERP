"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

// Shown only once Google sign-in is set up in Supabase (Authentication -> Providers -> Google)
// and NEXT_PUBLIC_AUTH_GOOGLE=on is set in Vercel.
export const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_AUTH_GOOGLE === "on";

export function GoogleButton({ next }: { next: string }) {
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
          const callback = `${window.location.origin}/auth/callback${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}`;
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
