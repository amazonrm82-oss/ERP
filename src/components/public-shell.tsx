import Link from "next/link";
import type { ReactNode } from "react";

import { Wordmark } from "@/components/wordmark";
import { DETAILS, LEGAL_DOCUMENTS } from "@/features/legal/documents";
import { whatsappUrl } from "@/lib/format";
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
          <nav aria-label="ניווט באתר" className="flex items-center gap-0.5 text-md whitespace-nowrap">
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

// the owner's phone and WhatsApp, in international form for the links
const CONTACT_E164 = `+972${DETAILS.phone.replace(/\D/g, "").replace(/^0/, "")}`;

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
        {/* a way to reach us from every public page (LND-09) */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>יצירת קשר:</span>
          <a href={`tel:${CONTACT_E164}`} className="underline-offset-4 hover:underline">
            <span dir="ltr">{DETAILS.phone}</span>
          </a>
          <a href={whatsappUrl(CONTACT_E164) ?? undefined} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
            <span dir="ltr">WhatsApp</span>
            <span className="sr-only">(נפתח בחלון חדש)</span>
          </a>
          <span dir="ltr">{APP_NAME}</span>
        </p>
      </div>
    </footer>
  );
}
