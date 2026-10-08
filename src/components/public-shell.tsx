import Link from "next/link";
import type { ReactNode } from "react";

import { Wordmark } from "@/components/wordmark";
import { LEGAL_DOCUMENTS } from "@/features/legal/documents";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";

/** Frame of the public pages (help center, legal documents): reachable signed in or not. */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href={paths.landing} className="shrink-0 rounded-md">
            <Wordmark className="h-6 sm:h-7" />
          </Link>
          <nav aria-label="ניווט באתר" className="flex items-center gap-0.5 text-[0.9375rem] whitespace-nowrap">
            <Link href={paths.help} className="flex min-h-10 items-center rounded-md px-2 hover:bg-canvas sm:px-3">
              מרכז עזרה
            </Link>
            <Link href={paths.home} className="flex min-h-10 items-center rounded-md px-2 font-medium sm:px-3 text-accent-strong hover:bg-canvas">
              כניסה למערכת
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-canvas">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6 text-sm text-ink-soft sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <nav aria-label="מסמכים ומידע">
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            <li>
              <Link href={paths.help} className="underline-offset-4 hover:underline">
                מרכז עזרה
              </Link>
            </li>
            {LEGAL_DOCUMENTS.map((doc) => (
              <li key={doc.slug}>
                <Link href={paths.legal(doc.slug)} className="underline-offset-4 hover:underline">
                  {doc.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <p dir="ltr" className="text-end sm:text-start">
          {APP_NAME}
        </p>
      </div>
    </footer>
  );
}
