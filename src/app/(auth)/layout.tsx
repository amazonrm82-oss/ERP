import type { ReactNode } from "react";

import Link from "next/link";

import { Wordmark } from "@/components/wordmark";
import { LEGAL_DOCUMENTS } from "@/features/legal/documents";
import { paths } from "@/lib/paths";

// terms, privacy and accessibility under the sign-in forms
const FOOTER_DOCS = LEGAL_DOCUMENTS.filter((doc) => ["terms", "privacy", "accessibility"].includes(doc.slug));

// The path a lead takes through the product. It is a real sequence, so it is
// drawn as one: an ordered list with a connecting line.
const JOURNEY = [
  { title: "ליד נכנס", text: "נרשם עם מקור, סטטוס ואחראי." },
  { title: "נוצר קשר", text: "כל שיחה והערה נשמרות בציר הזמן." },
  { title: "המרה לעסקה", text: "איש קשר ועסקה נוצרים בלחיצה אחת." },
  { title: "נסגר בהצלחה", text: "העסקה מתקדמת בלוח עד הסגירה." },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-surface lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
      <main className="flex flex-col px-5 py-6 sm:px-10 lg:px-16">
        <Wordmark className="h-7" />
        <div className="mx-auto my-auto w-full max-w-sm py-10">{children}</div>
        <nav aria-label="מסמכים ומידע" className="text-sm text-ink-soft">
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            <li>
              <Link href={paths.help} className="underline-offset-4 hover:underline">
                מרכז עזרה
              </Link>
            </li>
            {FOOTER_DOCS.map((doc) => (
              <li key={doc.slug}>
                <Link href={paths.legal(doc.slug)} className="underline-offset-4 hover:underline">
                  {doc.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </main>

      <aside aria-label="איך המערכת עובדת" className="hidden bg-brand px-12 py-16 text-on-brand lg:flex lg:flex-col lg:justify-center">
        <p className="max-w-sm text-3xl font-semibold leading-snug text-balance">
          מהפנייה הראשונה ועד סגירת העסקה, במקום אחד.
        </p>
        <ol className="mt-10 max-w-sm">
          {JOURNEY.map((step, index) => (
            <li key={step.title} className="relative flex gap-4 pb-7 last:pb-0">
              {index < JOURNEY.length - 1 ? (
                <span aria-hidden="true" className="absolute start-[0.4375rem] top-5 bottom-0 w-px bg-on-brand/30" />
              ) : null}
              <span aria-hidden="true" className="relative mt-1.5 size-[0.9375rem] shrink-0 rounded-full border-2 border-on-brand bg-accent" />
              <span>
                <span className="block font-semibold">{step.title}</span>
                <span className="block text-md text-on-brand/85">{step.text}</span>
              </span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
