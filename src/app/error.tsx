"use client";

import { ErrorState } from "@/components/error-state";

// Next.js 16 passes `retry` to error boundaries (re-fetches and re-renders the segment).
export default function ErrorPage(props: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main>
      <ErrorState {...props} />
    </main>
  );
}
