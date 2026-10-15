"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { AUTH_UNAVAILABLE_MESSAGE, AUTH_UNAVAILABLE_TITLE, isAuthUnavailableDigest } from "@/lib/auth-unavailable";

type Props = { error: Error & { digest?: string }; retry: () => void };

/** Body of the error boundaries: what happened, what to do, and a retry. */
export function ErrorState({ error, retry }: Props) {
  const unavailable = isAuthUnavailableDigest(error.digest);
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-start justify-center px-5 py-12">
      {/* FXC-10: the sign-in service did not answer; the user is still signed in */}
      <h1 className="text-2xl font-semibold">{unavailable ? AUTH_UNAVAILABLE_TITLE : "משהו השתבש"}</h1>
      <p className="mt-2 text-ink-soft">
        {unavailable ? AUTH_UNAVAILABLE_MESSAGE : "לא הצלחנו לטעון את הדף. אפשר לנסות שוב; אם זה חוזר, בדקו את החיבור לאינטרנט."}
      </p>
      {error.digest && !unavailable ? (
        <p className="mt-2 text-sm text-ink-soft">
          קוד שגיאה לתמיכה: <span dir="ltr">{error.digest}</span>
        </p>
      ) : null}
      <Button onClick={() => retry()} className="mt-6">
        ניסיון נוסף
      </Button>
    </div>
  );
}
