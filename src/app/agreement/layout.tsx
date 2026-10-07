import type { ReactNode } from "react";

import { Wordmark } from "@/components/wordmark";

export default function AgreementLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface">
      <header className="border-b border-line px-4 py-3 sm:px-6 print:hidden">
        <Wordmark className="h-7" />
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
