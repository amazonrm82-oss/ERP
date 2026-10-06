"use client";

import { ErrorState } from "@/components/error-state";

// Errors of a page inside the app keep the shell (navigation, top bar) on screen.
export default function OrgError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorState {...props} />;
}
