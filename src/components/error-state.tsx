"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

type Props = { error: Error & { digest?: string }; retry: () => void };

/** Body of the error boundaries: what happened, what to do, and a retry. */
export function ErrorState({ error, retry }: Props) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-start justify-center px-5 py-12">
      <h1 className="text-2xl font-semibold">משהו השתבש</h1>
      <p className="mt-2 text-ink-soft">לא הצלחנו לטעון את הדף. אפשר לנסות שוב; אם זה חוזר, בדקו את החיבור לאינטרנט.</p>
      {error.digest ? (
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
