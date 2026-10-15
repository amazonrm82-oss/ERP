"use client";

import "@fontsource-variable/heebo";
import "./globals.css";

import { ErrorState } from "@/components/error-state";
import { APP_NAME } from "@/lib/app";

// FXC-13: a failure in the root layout itself replaces the whole document, so this page brings its own <html>
// (Hebrew, right to left) and styles. It shows the same screen as every other error boundary: what happened, a
// retry, and the error code, which the server log carries too (src/instrumentation.ts).
export default function GlobalError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="he" dir="rtl">
      <body className="min-h-dvh bg-canvas antialiased">
        <title>{`משהו השתבש | ${APP_NAME}`}</title>
        <main>
          <ErrorState {...props} />
        </main>
      </body>
    </html>
  );
}
